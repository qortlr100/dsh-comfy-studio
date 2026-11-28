/**
 * The workflow service on a Cordis context with the real project layer and asset store: the component registers, a
 * stored graph file becomes a workflow, `resolve` reads it back, and `objectInfo` finds the node catalog of a catalog
 * entry (or nothing) without ever failing the caller.
 */
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import CsCatalog from "@cs/catalog";
import { fakeGraphEntry } from "@cs/catalog/testing/fake-provider";
import CsProject from "@cs/project";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { RecordId } from "@cs/project/types";
import { MemoryAssets, tempRoot, userOrigin } from "@cs/project/testing/support";
import { chatProject, provideChatServices } from "@cs/project/testing/workspaces";
import CsWorkflow from "./index.ts";
import { sampleGraph } from "./testing/graphs.ts";

/** Mount the project layer, the asset store and the workflow service, and make a project. */
async function mount(withCatalog = true) {
  const root = tempRoot();
  const context = new Context();
  onTestFinished(async () => {
    await context.fiber.dispose();
  });
  const services = provideChatServices(context);
  await context
    .plugin(CsProject, {
      projectsFolder: join(root, "projects"),
      cpuConcurrency: 1,
      gpuConcurrency: 1,
      promptSectionOrder: 4900,
    })
    .await();
  const assets = new MemoryAssets();
  context.csProject.registerAssetStore(assets);
  if (withCatalog) await context.plugin(CsCatalog, { factsTimeoutMs: 5000 }).await();
  await context.plugin(CsWorkflow, {}).await();
  const project = await chatProject(context.csProject, services, "Workflows", userOrigin());
  return { context, assets, project, csWorkflow: context.csWorkflow, csProject: context.csProject };
}

/** Make a workflow from the sample graph through the real asset store. */
async function makeWorkflow(f: Awaited<ReturnType<typeof mount>>): Promise<RecordId> {
  const file = f.assets.importAsset(
    f.project,
    new TextEncoder().encode(JSON.stringify(sampleGraph())),
    { mime: "application/json", name: "flow.json" },
  );
  const result = await f.csProject.run({
    ...userOrigin({ session: null }),
    project: f.project,
    operation: "workflow.create",
    params: {},
    inputs: [{ role: "file", ref: { asset: file } }],
  });
  if (result.record === null) throw new Error("create wrote no record");
  return result.record.id;
}

describe("CsWorkflow", () => {
  it("registers the workflow component, its reducer and its nine operations", async () => {
    const f = await mount();
    expect(
      f.csProject
        .listOperations()
        .filter((spec) => spec.component === "workflow")
        .map((spec) => spec.name)
        .toSorted(),
    ).toEqual(
      [
        "workflow.check_patch",
        "workflow.copy",
        "workflow.create",
        "workflow.delete",
        "workflow.get",
        "workflow.graph",
        "workflow.list",
        "workflow.save_variant",
        "workflow.update",
      ].toSorted(),
    );
    expect(f.csProject.getState(f.project).components.workflow).toEqual({ items: {} });
  });

  it("makes a workflow from a staged file and resolves it with its graph", async () => {
    const f = await mount();
    const id = await makeWorkflow(f);
    const resolved = f.csWorkflow.resolve(f.csProject.getState(f.project), id);
    expect(resolved.item).toMatchObject({ id, name: "flow", nodes: 7 });
    expect(Object.keys(resolved.graph).toSorted()).toEqual(Object.keys(sampleGraph()).toSorted());
    expect(resolved.graph["6"]?.inputs["text"]).toBe("a cat");
  });

  it("refuses to resolve a workflow the project does not have", async () => {
    const f = await mount();
    expect(() =>
      f.csWorkflow.resolve(f.csProject.getState(f.project), brandString<RecordId>("nope")),
    ).toThrowError("Unknown workflow 'nope'.");
  });
});

describe("CsWorkflow.resolve with odd IDs", () => {
  it("does not find a workflow under the name of an inherited member", async () => {
    const f = await mount();
    await makeWorkflow(f);
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(() =>
        f.csWorkflow.resolve(f.csProject.getState(f.project), brandString<RecordId>(name)),
      ).toThrowError(`Unknown workflow '${name}'.`);
    }
  });
});

describe("CsWorkflow.objectInfo", () => {
  it("answers nothing without a catalog service or entries", async () => {
    const without = await mount(false);
    expect(await without.csWorkflow.objectInfo(null)).toBeUndefined();
    const empty = await mount();
    expect(await empty.csWorkflow.objectInfo(null)).toBeUndefined();
    expect(await empty.csWorkflow.objectInfo({ provider: "fake", target: "one" })).toBeUndefined();
  });

  it("uses the only graph entry when no place is named, and the named entry otherwise", async () => {
    const f = await mount();
    const one = fakeGraphEntry({ lookups: true });
    f.context.csCatalog.register(one);
    expect(await f.csWorkflow.objectInfo(null)).toEqual({
      FakeNode: { input: {}, output: [] },
    });

    const two = fakeGraphEntry({ lookups: true, target: "two" });
    two.nodeCatalog = () => Promise.resolve({ Other: { input: {}, output: [] } });
    f.context.csCatalog.register(two);
    // Two entries and no named place: nothing to choose from.
    expect(await f.csWorkflow.objectInfo(null)).toBeUndefined();
    expect(await f.csWorkflow.objectInfo({ provider: "fake", target: "two" })).toEqual({
      Other: { input: {}, output: [] },
    });
    expect(await f.csWorkflow.objectInfo({ provider: "fake", target: "one" })).toEqual({
      FakeNode: { input: {}, output: [] },
    });
    expect(await f.csWorkflow.objectInfo({ provider: "fake", target: "three" })).toBeUndefined();
  });

  it("answers nothing for an entry without a node catalog", async () => {
    const f = await mount();
    f.context.csCatalog.register(fakeGraphEntry());
    expect(await f.csWorkflow.objectInfo(null)).toBeUndefined();
  });

  it("answers nothing when the node catalog fails or is not an object", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ lookups: true });
    f.context.csCatalog.register(entry);
    entry.nodeCatalog = () => Promise.reject(new Error("unreachable"));
    expect(await f.csWorkflow.objectInfo(null)).toBeUndefined();
    entry.nodeCatalog = () => Promise.resolve({ Bad: 5 });
    expect(await f.csWorkflow.objectInfo(null)).toEqual({});
  });

  it("stops waiting for a node catalog after the limit, and when the signal aborts", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ lookups: true });
    entry.nodeCatalog = () => new Promise(() => undefined);
    f.context.csCatalog.register(entry);

    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let answered = false;
    const waiting = f.csWorkflow.objectInfo(null).then((info) => {
      answered = true;
      return info;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBeUndefined();

    const controller = new AbortController();
    const aborted = f.csWorkflow.objectInfo(null, controller.signal);
    controller.abort();
    expect(await aborted).toBeUndefined();
    expect(await f.csWorkflow.objectInfo(null, controller.signal)).toBeUndefined();
  });
});
