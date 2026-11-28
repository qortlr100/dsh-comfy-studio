/**
 * Tests of the workflow operations over the real project layer: the operation table, making workflows from files,
 * the refusals before a record is written, variants and their graph check, deleting with undo, copying between
 * projects, agent permissions and the four reads through `run`.
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowParam } from "@cs/comfy/workflow";
import type { OperationContext, RecordId } from "@cs/project/types";
import { standIn, userOrigin } from "@cs/project/testing/support";
import { sampleGraph, sampleObjectInfo, pngWithGraph } from "./testing/graphs.ts";
import { mount } from "./testing/operations.ts";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_OPERATIONS,
  type WorkflowGetReport,
  type WorkflowGraphReport,
  type WorkflowListReport,
  type WorkflowMadeReport,
  type WorkflowPatchReport,
} from "./types.ts";

/** @returns the refusal's code and message of a rejected promise. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("Expected the call to be refused.");
}

const SET_PREFIX = [{ op: "set", node: "9", input: "filename_prefix", value: "variant" }];

describe("the operation table", () => {
  it("declares the nine operations with their agent values and flags", async () => {
    const f = await mount();
    const table = Object.fromEntries(
      f.operations.map((spec) => [
        spec.name,
        { agent: spec.agent ?? "run", readOnly: spec.readOnly === true },
      ]),
    );
    expect(table).toEqual({
      "workflow.create": { agent: "none", readOnly: false },
      "workflow.update": { agent: "none", readOnly: false },
      "workflow.save_variant": { agent: "run", readOnly: false },
      "workflow.copy": { agent: "none", readOnly: false },
      "workflow.delete": { agent: "propose", readOnly: false },
      "workflow.list": { agent: "run", readOnly: true },
      "workflow.get": { agent: "run", readOnly: true },
      "workflow.graph": { agent: "run", readOnly: true },
      "workflow.check_patch": { agent: "run", readOnly: true },
    });
    expect(Object.values(WORKFLOW_OPERATIONS).toSorted()).toEqual(Object.keys(table).toSorted());
    for (const spec of f.operations) {
      expect([spec.component, spec.version, spec.resource, spec.deterministic]).toEqual([
        "workflow",
        "1",
        "none",
        false,
      ]);
      expect(spec.label).toMatch(/\S/);
      expect(spec.description.split(/\s+/).length).toBeLessThanOrEqual(90);
    }
  });

  it("tells an agent how to change a graph: read, check, save as a variant", async () => {
    const f = await mount();
    const text = (name: string) => f.defined(f.operations.find((s) => s.name === name)).description;
    expect(text("workflow.save_variant")).toContain("cs_workflow_graph");
    expect(text("workflow.save_variant")).toContain("cs_workflow_check_patch");
    expect(text("workflow.save_variant")).toContain('{op:"link"');
    expect(text("workflow.graph")).toContain("patch");
    expect(text("workflow.delete")).toContain("proposal");
  });
});

describe("workflow.create", () => {
  it("makes a workflow from a JSON file, named after the file, with the graph in a blob", async () => {
    const f = await mount();
    const file = f.uploadGraph(sampleGraph(), "My Flow.json");
    const result = await f.run(WORKFLOW_OPERATIONS.create, {}, { file });
    const record = f.defined(result.record);
    expect(record.status).toBe("done");
    expect(result.outputs).toEqual([]);

    const made = f.report<WorkflowMadeReport>(result);
    const item = f.item(record.id);
    expect(item).toMatchObject({
      id: record.id,
      name: "My Flow",
      description: "",
      graph: made.graph,
      parent: null,
      target: null,
      nodes: 7,
    });
    expect(item.fields.length).toBeGreaterThan(0);
    expect(made.fields).toEqual(item.fields);
    expect(f.blobs.get(made.graph)?.mime).toBe("application/json");
    expect(f.blobs.get(made.graph)?.name).toBe("My Flow.workflow.json");
    expect(Object.keys(f.graphOf(record.id))).toHaveLength(7);
    expect(f.history()[0]).toBe("workflow.create");
  });

  it("stores the same graph once, whatever the order of its keys in the file", async () => {
    const f = await mount();
    const graph = sampleGraph();
    const reordered = Object.fromEntries(Object.entries(graph).toReversed());
    const a = await f.make(graph);
    const b = await f.make(reordered);
    expect(f.item(a).graph).toBe(f.item(b).graph);
  });

  it("makes a workflow from a PNG that ComfyUI wrote", async () => {
    const f = await mount();
    const file = f.upload(pngWithGraph(sampleGraph()), "shot.png", "image/png");
    const result = await f.run(WORKFLOW_OPERATIONS.create, { description: "from a PNG" }, { file });
    const item = f.item(f.defined(result.record).id);
    expect(item).toMatchObject({ name: "shot", description: "from a PNG", nodes: 7 });
  });

  it("takes a given name and default place, and asks the host for that place's node catalog", async () => {
    const f = await mount({ objectInfo: sampleObjectInfo() });
    const target = { provider: "comfy", target: "main" };
    const id = await f.make(sampleGraph(), { name: "  Portrait  ", target });
    expect(f.item(id)).toMatchObject({ name: "Portrait", target });
    expect(f.objectInfoCalls).toEqual([target]);
    // With the catalog the checkpoint field offers the server's choices.
    const ckpt = f.item(id).fields.find((field) => field.id === "4.ckpt_name");
    expect(ckpt?.options).toEqual(["v1-5.safetensors", "sdxl.safetensors"]);
  });

  it("refuses what it cannot make, writing no record", async () => {
    const f = await mount();
    const before = f.count();
    const bad = f.upload(new TextEncoder().encode("not json"), "bad.json");
    expect((await refusal(f.run("workflow.create", {}, { file: bad }))).code).toBe(
      "invalid_inputs",
    );

    const ui = f.upload(new TextEncoder().encode('{"nodes":[],"links":[]}'), "ui.json");
    const uiFailure = await refusal(f.run("workflow.create", {}, { file: ui }));
    expect(uiFailure.code).toBe("invalid_inputs");
    expect(uiFailure.message).toContain("API format");

    const huge = f.upload(new Uint8Array(5 * 1024 * 1024 + 1), "huge.json");
    expect((await refusal(f.run("workflow.create", {}, { file: huge }))).code).toBe(
      "invalid_inputs",
    );

    const good = f.uploadGraph();
    expect((await refusal(f.run("workflow.create", { name: "   " }, { file: good }))).code).toBe(
      "invalid_params",
    );
    expect(
      (await refusal(f.run("workflow.create", { name: "x".repeat(101) }, { file: good }))).code,
    ).toBe("invalid_params");
    expect(
      (await refusal(f.run("workflow.create", { description: "x".repeat(2001) }, { file: good })))
        .code,
    ).toBe("invalid_params");
    expect(
      (
        await refusal(
          f.run("workflow.create", { target: { provider: "", target: "a" } }, { file: good }),
        )
      ).code,
    ).toBe("invalid_params");
    await refusal(f.run("workflow.create", {}));
    expect(f.count()).toBe(before);
  });
});

describe("workflow.update", () => {
  it("changes the name, description, fields and default place, never the graph", async () => {
    const f = await mount();
    const id = await f.make();
    const graph = f.item(id).graph;
    const fields: WorkflowParam[] = f
      .item(id)
      .fields.slice(0, 2)
      .map((field) => ({ ...field }));
    const target = { provider: "comfy", target: "main" };

    await f.run("workflow.update", {
      workflow: id,
      name: "Renamed",
      description: "d",
      fields,
      target,
    });
    expect(f.item(id)).toMatchObject({ name: "Renamed", description: "d", fields, target, graph });

    await f.run("workflow.update", { workflow: id, target: null });
    expect(f.item(id).target).toBeNull();
    expect(f.item(id).fields).toEqual(fields);
  });

  it("refuses an empty change, an unknown workflow, bad fields and a bad target, writing nothing", async () => {
    const f = await mount();
    const id = await f.make();
    const before = f.count();
    const unknown = await refusal(f.run("workflow.update", { workflow: "nope", name: "x" }));
    expect(unknown).toEqual({ code: "invalid_params", message: "Unknown workflow 'nope'." });
    expect((await refusal(f.run("workflow.update", { workflow: id }))).code).toBe("invalid_params");
    expect((await refusal(f.run("workflow.update", { workflow: id, name: "" }))).code).toBe(
      "invalid_params",
    );
    const unbound = {
      id: "99.nothing",
      nodeId: "99",
      input: "nothing",
      label: "x",
      type: "text",
      default: "",
    };
    expect(
      (await refusal(f.run("workflow.update", { workflow: id, fields: [unbound] }))).code,
    ).toBe("invalid_params");
    expect(
      (await refusal(f.run("workflow.update", { workflow: id, target: { provider: "a" } }))).code,
    ).toBe("invalid_params");
    expect(f.count()).toBe(before);
  });
});

describe("workflow.save_variant", () => {
  it("saves a new workflow and leaves the parent's graph as it was", async () => {
    const f = await mount();
    const parent = await f.make(sampleGraph(), { name: "Base" });
    const parentGraph = f.item(parent).graph;

    const result = await f.run("workflow.save_variant", {
      workflow: parent,
      ops: [...SET_PREFIX, { op: "set", node: "6", input: "text", value: "a dog" }],
      name: "Variant",
      description: "prefix changed",
    });
    const variantId = f.defined(result.record).id;
    const variant = f.item(variantId);
    expect(variant).toMatchObject({
      name: "Variant",
      description: "prefix changed",
      parent,
      nodes: 7,
    });
    expect(f.item(parent).graph).toBe(parentGraph);
    expect(variant.graph).not.toBe(parentGraph);
    expect(f.graphOf(parent)["9"]?.inputs["filename_prefix"]).toBe("ComfyUI");
    expect(f.graphOf(variantId)["9"]?.inputs["filename_prefix"]).toBe("variant");
    // The fields come along; the one the patch gave a value takes it as its default.
    expect(variant.fields.find((field) => field.id === "6.text")?.default).toBe("a dog");
    expect(f.item(parent).fields.find((field) => field.id === "6.text")?.default).toBe("a cat");
    expect(variant.fields.map((field) => field.id)).toEqual(
      expect.arrayContaining(f.item(parent).fields.map((field) => field.id)),
    );
    expect(f.report<WorkflowMadeReport>(result).warnings).toBeUndefined();
  });

  it("adds the suggested fields of a node the patch adds", async () => {
    const f = await mount();
    const parent = await f.make();
    const result = await f.run("workflow.save_variant", {
      workflow: parent,
      name: "More",
      ops: [
        {
          op: "add",
          id: "20",
          class_type: "EmptyLatentImage",
          inputs: { width: 64, height: 64, batch_size: 1 },
        },
      ],
    });
    const variant = f.item(f.defined(result.record).id);
    expect(variant.nodes).toBe(8);
    expect(variant.fields.some((field) => field.nodeId === "20")).toBe(true);
  });

  it("refuses a patch that does not apply or breaks the graph, writing no record", async () => {
    const f = await mount();
    const parent = await f.make();
    const before = f.count();
    const call = (ops: unknown, name = "V") =>
      f.run("workflow.save_variant", { workflow: parent, ops, name });
    const missing = await refusal(call([{ op: "remove", node: "404" }]));
    expect(missing.code).toBe("invalid_params");
    expect(missing.message).toMatch(/^op 1: /);
    // Removing the only output node leaves a graph that cannot run.
    expect((await refusal(call([{ op: "remove", node: "9" }]))).code).toBe("invalid_params");
    expect((await refusal(call([]))).code).toBe("invalid_params");
    expect((await refusal(call([{ op: "explode" }]))).code).toBe("invalid_params");
    expect((await refusal(call(SET_PREFIX, "  "))).code).toBe("invalid_params");
    expect(
      (
        await refusal(
          f.run("workflow.save_variant", { workflow: "nope", ops: SET_PREFIX, name: "V" }),
        )
      ).code,
    ).toBe("invalid_params");
    expect(f.count()).toBe(before);
  });

  it("fails the record with invalid_graph when the server's node catalog rejects the graph", async () => {
    const f = await mount({ objectInfo: sampleObjectInfo() });
    const parent = await f.make();
    const items = Object.keys(f.slice().items);
    const result = await f.run("workflow.save_variant", {
      workflow: parent,
      name: "Broken",
      ops: [{ op: "add", id: "30", class_type: "NoSuchNode", inputs: {} }],
    });
    const record = f.defined(result.record);
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("invalid_graph");
    expect(record.error?.message).toContain("NoSuchNode");
    expect(Object.keys(f.slice().items)).toEqual(items);
  });

  it("puts the warnings of the graph check in the report and keeps the variant", async () => {
    const f = await mount({ objectInfo: sampleObjectInfo() });
    const parent = await f.make();
    const result = await f.run("workflow.save_variant", {
      workflow: parent,
      name: "Warned",
      ops: [{ op: "set", node: "9", input: "undeclared", value: "x" }],
    });
    const record = f.defined(result.record);
    expect(record.status).toBe("done");
    const warnings = f.report<WorkflowMadeReport>(result).warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("undeclared");
    expect(f.item(record.id).parent).toBe(parent);
  });

  it("is something an agent does at once, as a record of the agent", async () => {
    const f = await mount();
    const parent = await f.make();
    const result = await f.run(
      "workflow.save_variant",
      { workflow: parent, ops: SET_PREFIX, name: "By agent" },
      { agent: true },
    );
    expect(f.defined(result.record)).toMatchObject({ actor: "agent", status: "done" });
    expect(f.item(f.defined(result.record).id).parent).toBe(parent);
  });
});

describe("agent permissions", () => {
  it("refuses an agent's run of the operations that are the user's", async () => {
    const f = await mount();
    const id = await f.make();
    const file = f.uploadGraph();
    const before = f.count();
    const as = { agent: true };
    expect((await refusal(f.run("workflow.create", {}, { file, ...as }))).code).toBe(
      "agent_not_allowed",
    );
    expect((await refusal(f.run("workflow.update", { workflow: id, name: "x" }, as))).code).toBe(
      "agent_not_allowed",
    );
    expect(
      (await refusal(f.run("workflow.copy", { project: f.other, workflow: id }, as))).code,
    ).toBe("agent_not_allowed");
    expect((await refusal(f.run("workflow.delete", { workflow: id }, as))).code).toBe(
      "agent_not_allowed",
    );
    expect(f.count()).toBe(before);
    expect(f.slice().items[id]).toBeDefined();
  });

  it("turns an agent's delete into a proposal that changes nothing until the user runs it", async () => {
    const f = await mount();
    const id = await f.make();
    const proposal = await f.propose("workflow.delete", { workflow: id });
    expect(proposal.operation).toBe("proj.propose");
    expect(f.slice().items[id]).toBeDefined();
    await f.run("workflow.delete", { workflow: id });
    expect(f.slice().items[id]).toBeUndefined();
  });

  it("lets an agent use the four reads", async () => {
    const f = await mount();
    const id = await f.make();
    for (const [operation, params] of [
      ["workflow.list", {}],
      ["workflow.get", { workflow: id }],
      ["workflow.graph", { workflow: id }],
      ["workflow.check_patch", { workflow: id, ops: SET_PREFIX }],
    ] as const) {
      const result = await f.run(operation, params, { agent: true });
      expect(result.record).toBeNull();
    }
  });
});

describe("workflow.delete", () => {
  it("deletes a workflow, clears the parent of its variants, and undo restores both", async () => {
    const f = await mount();
    const parent = await f.make();
    const variant = f.defined(
      (await f.run("workflow.save_variant", { workflow: parent, ops: SET_PREFIX, name: "V" }))
        .record,
    ).id;
    expect(f.item(variant).parent).toBe(parent);

    await f.run("workflow.delete", { workflow: parent });
    expect(f.slice().items[parent]).toBeUndefined();
    expect(f.item(variant).parent).toBeNull();

    await f.undo();
    expect(f.item(parent).name).toBe("flow");
    expect(f.item(variant).parent).toBe(parent);
  });

  it("refuses an unknown workflow", async () => {
    const f = await mount();
    const before = f.count();
    expect((await refusal(f.run("workflow.delete", { workflow: "nope" }))).code).toBe(
      "invalid_params",
    );
    expect(f.count()).toBe(before);
  });
});

describe("workflow.copy", () => {
  it("copies a workflow of another project with its graph, fields and name, but no parent or place", async () => {
    const f = await mount();
    const parent = await f.make(sampleGraph(), { name: "Source" }, { project: f.other });
    const variant = f.defined(
      (
        await f.run(
          "workflow.save_variant",
          { workflow: parent, ops: SET_PREFIX, name: "Source variant", description: "d" },
          { project: f.other },
        )
      ).record,
    ).id;
    await f.run(
      "workflow.update",
      { workflow: variant, target: { provider: "comfy", target: "main" } },
      { project: f.other },
    );
    const source = f.item(variant, f.other);

    const result = await f.run("workflow.copy", { project: f.other, workflow: variant });
    const copied = f.item(f.defined(result.record).id);
    expect(copied).toMatchObject({
      name: "Source variant",
      description: "d",
      fields: source.fields,
      nodes: source.nodes,
      parent: null,
      target: null,
    });
    expect(f.graphOf(copied.id)).toEqual(f.graphOf(variant, f.other));
    expect(f.slice().items[variant]).toBeUndefined();
    // The other project is untouched.
    expect(Object.keys(f.slice(f.other).items)).toHaveLength(2);
  });

  it("refuses the same project, an unknown project and an unknown workflow, writing nothing", async () => {
    const f = await mount();
    const mine = await f.make();
    const theirs = await f.make(sampleGraph(), {}, { project: f.other });
    const before = f.count();
    expect(
      (await refusal(f.run("workflow.copy", { project: f.project, workflow: mine }))).code,
    ).toBe("invalid_params");
    expect((await refusal(f.run("workflow.copy", { project: f.other, workflow: mine }))).code).toBe(
      "invalid_params",
    );
    await refusal(f.run("workflow.copy", { project: "project-99", workflow: theirs }));
    expect(f.count()).toBe(before);
  });
});

describe("the reads", () => {
  it("answer through run without writing a record", async () => {
    const f = await mount();
    const parent = await f.make(sampleGraph(), { name: "Base", description: "the base" });
    const variant = f.defined(
      (await f.run("workflow.save_variant", { workflow: parent, ops: SET_PREFIX, name: "V" }))
        .record,
    ).id;
    const before = f.count();

    const list = await f.run("workflow.list", {});
    expect(list.record).toBeNull();
    const workflows = f.report<WorkflowListReport>(list).workflows;
    expect(workflows.map((w) => w.id).toSorted()).toEqual([parent, variant].toSorted());
    expect(
      f.report<WorkflowListReport>(await f.run("workflow.list", { q: "base" })).workflows,
    ).toHaveLength(1);

    const get = await f.run("workflow.get", { workflow: variant });
    expect(get.record).toBeNull();
    expect(f.report<WorkflowGetReport>(get)).toMatchObject({
      id: variant,
      parent: { id: parent, name: "Base" },
    });

    const graph = await f.run("workflow.graph", { workflow: parent });
    expect(graph.record).toBeNull();
    expect(f.report<WorkflowGraphReport>(graph)).toMatchObject({
      workflow: parent,
      nodes: 7,
      form: "nodes",
    });
    expect(f.report<WorkflowGraphReport>(graph).text).toContain("KSampler");
    const some = await f.run("workflow.graph", { workflow: parent, nodes: ["9"] });
    expect(f.report<WorkflowGraphReport>(some).text).toContain("SaveImage");
    expect(f.report<WorkflowGraphReport>(some).text).not.toContain("KSampler");

    const check = await f.run("workflow.check_patch", { workflow: parent, ops: SET_PREFIX });
    expect(check.record).toBeNull();
    expect(f.report<WorkflowPatchReport>(check)).toMatchObject({
      ok: true,
      checked_against_server: false,
    });

    expect(f.count()).toBe(before);
  });

  it("check_patch reports a patch that does not apply instead of refusing it", async () => {
    const f = await mount();
    const id = await f.make();
    const bad = await f.run("workflow.check_patch", {
      workflow: id,
      ops: [{ op: "remove", node: "404" }],
    });
    expect(f.report<WorkflowPatchReport>(bad)).toMatchObject({ ok: false });
    expect(f.report<WorkflowPatchReport>(bad).error).toMatch(/^op 1: /);
    const worse = await f.run("workflow.check_patch", {
      workflow: id,
      ops: [{ op: "set", node: "9" }],
    });
    expect(f.report<WorkflowPatchReport>(worse).ok).toBe(false);
  });

  it("check_patch uses the server's node catalog for the workflow's place, or the one it is given", async () => {
    const f = await mount({ objectInfo: sampleObjectInfo() });
    const target = { provider: "comfy", target: "main" };
    const id = await f.make(sampleGraph(), { target });
    f.objectInfoCalls.length = 0;
    const ops = [{ op: "add", id: "30", class_type: "NoSuchNode", inputs: {} }];

    const own = f.report<WorkflowPatchReport>(
      await f.run("workflow.check_patch", { workflow: id, ops }),
    );
    expect(own).toMatchObject({ ok: false, checked_against_server: true });
    expect(own.problems[0]?.message).toContain("NoSuchNode");
    const other = { provider: "comfy", target: "other" };
    await f.run("workflow.check_patch", { workflow: id, ops, target: other });
    expect(f.objectInfoCalls).toEqual([target, other]);

    f.setObjectInfo(undefined);
    const unchecked = f.report<WorkflowPatchReport>(
      await f.run("workflow.check_patch", { workflow: id, ops }),
    );
    expect(unchecked).toMatchObject({ ok: true, checked_against_server: false });
  });

  it("refuse an unknown workflow", async () => {
    const f = await mount();
    for (const [operation, params] of [
      ["workflow.get", { workflow: "nope" }],
      ["workflow.graph", { workflow: "nope" }],
      ["workflow.check_patch", { workflow: "nope", ops: SET_PREFIX }],
    ] as const) {
      expect((await refusal(f.run(operation, params))).code).toBe("invalid_params");
    }
  });
});

describe("summaries", () => {
  it("say what each finished record did", async () => {
    const f = await mount();
    const create = await f.run("workflow.create", { name: "Base" }, { file: f.uploadGraph() });
    const id = f.defined(create.record).id;
    const variant = await f.run("workflow.save_variant", {
      workflow: id,
      ops: SET_PREFIX,
      name: "V",
    });
    const summary = (name: string, record: Parameters<(typeof f.operations)[0]["summarize"]>[0]) =>
      f.defined(f.operations.find((spec) => spec.name === name)).summarize(record);
    expect(summary("workflow.create", f.defined(create.record))).toMatch(
      /^made workflow "Base" \(7 nodes, \d+ fields\)$/,
    );
    expect(summary("workflow.save_variant", f.defined(variant.record))).toBe('saved variant "V"');
  });
});

describe("a workflow is always left behind by a finished make", () => {
  it("creates from a graph whose node title is far over the label limit", async () => {
    const f = await mount();
    const graph = sampleGraph();
    graph["6"] = {
      class_type: "CLIPTextEncode",
      inputs: { text: "a cat", clip: ["4", 1] },
      _meta: { title: "T".repeat(120) },
    };
    const id = await f.make(graph);
    const prompt = f.item(id).fields.find((field) => field.id === "6.text");
    expect(prompt).toBeDefined();
    expect(Array.from(prompt?.label ?? "").length).toBeLessThanOrEqual(100);
  });

  it("saves a variant whose added node has a title of 150 characters", async () => {
    const f = await mount();
    const parent = await f.make();
    const result = await f.run("workflow.save_variant", {
      workflow: parent,
      name: "Long title",
      ops: [
        {
          op: "add",
          id: "20",
          class_type: "EmptyLatentImage",
          title: "L".repeat(150),
          inputs: { width: 64, height: 64, batch_size: 1 },
        },
      ],
    });
    const variant = f.item(f.defined(result.record).id);
    expect(variant.nodes).toBe(8);
    const added = variant.fields.filter((field) => field.nodeId === "20");
    expect(added.length).toBeGreaterThan(0);
    for (const field of added) expect(Array.from(field.label).length).toBeLessThanOrEqual(100);
  });
});

describe("a stop during the wait for the node catalog", () => {
  it("ends workflow.save_variant as stopped and adds no workflow", async () => {
    const f = await mount();
    const parent = await f.make();
    const release = Promise.withResolvers<void>();
    f.holdCatalog(release.promise);
    const stop = new AbortController();
    const running = f.run(
      "workflow.save_variant",
      { workflow: parent, ops: SET_PREFIX, name: "V" },
      { signal: stop.signal },
    );
    await vi.waitFor(() => {
      expect(f.objectInfoCalls.length).toBeGreaterThan(1);
    });
    stop.abort();
    release.resolve();
    const record = f.defined((await running).record);
    expect(record.status).toBe("cancelled");
    expect(record.error?.code).toBe("stopped");
    expect(Object.keys(f.slice().items)).toEqual([parent]);
  });

  it("ends workflow.create as stopped and adds no workflow", async () => {
    const f = await mount();
    const release = Promise.withResolvers<void>();
    f.holdCatalog(release.promise);
    const stop = new AbortController();
    const running = f.run("workflow.create", {}, { file: f.uploadGraph(), signal: stop.signal });
    await vi.waitFor(() => {
      expect(f.objectInfoCalls).toHaveLength(1);
    });
    stop.abort();
    release.resolve();
    const record = f.defined((await running).record);
    expect(record.status).toBe("cancelled");
    expect(record.error?.code).toBe("stopped");
    expect(Object.keys(f.slice().items)).toEqual([]);
  });
});

describe("IDs named like members of Object.prototype", () => {
  it("are unknown workflows, for reads, delete, variants and copy", async () => {
    const f = await mount();
    await f.make();
    const before = f.count();
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      for (const [operation, params] of [
        ["workflow.get", { workflow: name }],
        ["workflow.graph", { workflow: name }],
        ["workflow.delete", { workflow: name }],
        ["workflow.check_patch", { workflow: name, ops: SET_PREFIX }],
        ["workflow.save_variant", { workflow: name, ops: SET_PREFIX, name: "V" }],
        ["workflow.update", { workflow: name, name: "x" }],
        ["workflow.copy", { project: f.other, workflow: name }],
      ] as const) {
        expect((await refusal(f.run(operation, params))).code).toBe("invalid_params");
      }
    }
    expect(f.count()).toBe(before);
  });

  it("are missing nodes for a patch, which is refused with an op number and writes nothing", async () => {
    const f = await mount();
    const parent = await f.make();
    const before = f.count();
    for (const node of ["constructor", "toString", "__proto__"]) {
      for (const op of [
        { op: "set", node, input: "x", value: 1 },
        { op: "link", node, input: "x", from: { node: "4", output: 0 } },
        { op: "remove", node },
      ]) {
        const failure = await refusal(
          f.run("workflow.save_variant", { workflow: parent, ops: [op], name: "V" }),
        );
        expect(failure.code).toBe("invalid_params");
        expect(failure.message).toMatch(/^op 1: /);
        const check = f.report<WorkflowPatchReport>(
          await f.run("workflow.check_patch", { workflow: parent, ops: [op] }),
        );
        expect(check.ok).toBe(false);
        expect(check.error).toMatch(/^op 1: /);
      }
    }
    expect(f.count()).toBe(before);
  });
});

describe("a variant's pinned defaults", () => {
  it("refuses a seed of -1 and a number set into a text field, writing nothing", async () => {
    const f = await mount();
    const parent = await f.make();
    const before = f.count();
    const seed = await refusal(
      f.run("workflow.save_variant", {
        workflow: parent,
        name: "V",
        ops: [{ op: "set", node: "3", input: "seed", value: -1 }],
      }),
    );
    expect(seed.code).toBe("invalid_params");
    expect(seed.message).toContain("field '3.seed'");
    expect(seed.message).toContain("a value it does not take");
    const text = await refusal(
      f.run("workflow.save_variant", {
        workflow: parent,
        name: "V",
        ops: [{ op: "set", node: "6", input: "text", value: 5 }],
      }),
    );
    expect(text.code).toBe("invalid_params");
    expect(text.message).toContain("field '6.text'");
    expect(f.count()).toBe(before);
  });

  it("fails with invalid_graph when execute meets one", async () => {
    const f = await mount();
    const parent = await f.make();
    const spec = f.defined(f.operations.find((s) => s.name === "workflow.save_variant"));
    const context = standIn<OperationContext>({
      params: {
        workflow: parent,
        name: "V",
        ops: [{ op: "set", node: "3", input: "seed", value: -1 }],
      },
      state: f.modules.reducers.getState(f.project),
      signal: new AbortController().signal,
    });
    await expect(spec.execute(context)).rejects.toMatchObject({
      code: "invalid_graph",
      message: expect.stringContaining("a value it does not take") as unknown,
    });
  });
});

describe("workflow.update keeps large field lists out of the record", () => {
  it("refuses a field with too many choices and a default over the limit", async () => {
    const f = await mount();
    const id = await f.make();
    const before = f.count();
    const base = f.item(id).fields.find((field) => field.id === "3.sampler_name");
    const sampler = f.defined(base);
    const many = Array.from({ length: WORKFLOW_LIMITS.fieldOptions + 1 }, (_, i) => `m${i}`);
    const options = await refusal(
      f.run("workflow.update", { workflow: id, fields: [{ ...sampler, options: many }] }),
    );
    expect(options.code).toBe("invalid_params");
    expect(options.message).toContain("leave 'options' out");
    const text = f.defined(f.item(id).fields.find((field) => field.id === "6.text"));
    const long = await refusal(
      f.run("workflow.update", {
        workflow: id,
        fields: [{ ...text, default: "x".repeat(WORKFLOW_LIMITS.fieldDefaultChars + 1) }],
      }),
    );
    expect(long.code).toBe("invalid_params");
    expect(long.message).toContain("default is over");
    expect(f.count()).toBe(before);
    // At the limit it is accepted.
    await f.run("workflow.update", {
      workflow: id,
      fields: [{ ...text, default: "x".repeat(WORKFLOW_LIMITS.fieldDefaultChars) }],
    });
    expect(f.item(id).fields).toHaveLength(1);
  });
});

describe("workflow.create's file input", () => {
  it("says an unresolvable reference could not be resolved", async () => {
    const f = await mount();
    // The runner refuses most bad references first; the operation still has to word what it cannot resolve.
    const spec = f.defined(f.operations.find((s) => s.name === "workflow.create"));
    const request = {
      project: f.project,
      operation: spec.name,
      params: {},
      inputs: [{ role: "file", ref: { record: brandString<RecordId>("nope"), output: 0 } }],
      ...userOrigin(),
    };
    const failure = await refusal(
      Promise.resolve().then(() =>
        spec.precondition?.(request, f.modules.reducers.getState(f.project)),
      ),
    );
    expect(failure.code).toBe("invalid_inputs");
    expect(failure.message).toContain("could not be resolved");
    expect(failure.message).toContain("asset ID");
    const none = await refusal(f.run("workflow.create", {}));
    expect(none.message).toBe("Give the graph file as the `file` input.");
  });
});

describe("workflow.copy's precondition", () => {
  it("checks the source with the host's existence check without reading it", async () => {
    const f = await mount({ withHas: true });
    const source = await f.make(sampleGraph(), { name: "Source" }, { project: f.other });
    f.reads.length = 0;
    const spec = f.defined(f.operations.find((s) => s.name === "workflow.copy"));
    await spec.precondition?.(
      {
        project: f.project,
        operation: spec.name,
        params: { project: f.other, workflow: source },
        inputs: [],
        ...userOrigin(),
      },
      f.modules.reducers.getState(f.project),
    );
    expect(f.reads).toEqual([]);
    // The run itself still reads the bytes once, to copy them.
    await f.run("workflow.copy", { project: f.other, workflow: source });
    expect(f.reads).toHaveLength(1);
  });

  it("falls back to reading when the host has no existence check", async () => {
    const f = await mount();
    const source = await f.make(sampleGraph(), { name: "Source" }, { project: f.other });
    f.reads.length = 0;
    await f.run("workflow.copy", { project: f.other, workflow: source });
    expect(f.reads).toHaveLength(2);
  });
});
