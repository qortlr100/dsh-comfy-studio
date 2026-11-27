/**
 * Tests of the scheduler: scheduled runs (`after`) start in dependency order, respect the `gpu` limit, fail without
 * running when a record they wait for failed, and `wait` settles when the project has nothing queued or running.
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it, vi } from "vitest";
import type { ProjectModules } from "./testing/support.ts";
import { createTestProject, defined, startModules, userOrigin } from "./testing/support.ts";
import type { OperationSpec } from "./operation-types.ts";
import type { OperationContext, ProjectId, ProjectRecord, RecordId, RunRequest } from "./types.ts";

/**
 * An operation spec with test defaults: one optional `prompt` parameter, the `reference` input role, not
 * deterministic, and unlimited resource.
 * @param overrides - the fields to set; `name`, `component` and `execute` are required.
 * @returns the spec.
 */
function operation(
  overrides: Partial<OperationSpec> & Pick<OperationSpec, "name" | "component" | "execute">,
): OperationSpec {
  return {
    version: "1",
    params: { prompt: { type: "string" } },
    deterministic: false,
    inputs: { reference: { type: "image", description: "A reference.", many: true } },
    outputs: [],
    description: "A test operation.",
    summarize: () => "ran",
    resource: "none",
    ...overrides,
  };
}

/** A placeholder that a test replaces once the real function exists. */
const noop = (): void => undefined;

/** @returns a promise with its resolve function, for holding an execute until the test releases it. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Schedule one call as a human edit on `main`.
 * @param m - the modules.
 * @param project - the project.
 * @param name - the operation name.
 * @param prompt - the `prompt` parameter, which the test execute functions use as a label.
 * @param extra - other request fields; `after` defaults to none.
 * @returns the pending record.
 */
async function schedule(
  m: ProjectModules,
  project: ProjectId,
  name: string,
  prompt: string,
  extra: Partial<RunRequest> = {},
): Promise<ProjectRecord> {
  const result = await m.runner.run({
    project,
    operation: name,
    params: { prompt },
    inputs: [],
    after: [],
    ...userOrigin(),
    ...extra,
  });
  expect(result.record?.status).toBe("pending");
  return defined(result.record, "the scheduled record");
}

/**
 * Create one output asset named after the call's prompt.
 * @param context - the execute context.
 * @returns the asset ID.
 */
function importVariant(context: OperationContext): ReturnType<OperationContext["importAsset"]> {
  return context.importAsset(Buffer.from(`variant ${String(context.params["prompt"])}`), {
    mime: "video/mp4",
    name: "variant.mp4",
  });
}

describe("Scheduler", () => {
  it("runs scheduled records in dependency order", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const order: string[] = [];
    const seenInputs: OperationContext["inputs"][] = [];
    const first = gate();
    m.runner.registerOperation(
      operation({
        name: "image.generate_ref2va",
        component: "image",
        execute: async (context) => {
          const prompt = String(context.params["prompt"]);
          if (prompt === "A") await first.promise;
          order.push(prompt);
          seenInputs.push(context.inputs);
          return { outputs: [importVariant(context)] };
        },
      }),
    );

    const a = await schedule(m, project, "image.generate_ref2va", "A");
    const b = await schedule(m, project, "image.generate_ref2va", "B", { after: [a.id] });
    const c = await schedule(m, project, "image.generate_ref2va", "C", {
      inputs: [{ role: "reference", ref: { record: b.id, output: 0 } }],
    });
    expect(m.store.getRecord(project, c.id).inputs[0]?.resolved_asset).toBeNull();
    first.resolve();
    await m.scheduler.wait(project);

    expect(order).toEqual(["A", "B", "C"]);
    const variant = m.store.getRecord(project, b.id).outputs[0];
    expect(m.store.getRecord(project, c.id).inputs[0]?.resolved_asset).toBe(variant);
    expect(seenInputs[2]?.[0]?.resolved_asset).toBe(variant);
  });

  it("keeps at most one gpu record running", async () => {
    const m = startModules({ cpu: 4, gpu: 1 });
    const project = await createTestProject(m);
    const gates = new Map([
      ["gpu 1", gate()],
      ["gpu 2", gate()],
    ]);
    const started: string[] = [];
    let runningGpu = 0;
    let mostGpu = 0;
    m.runner.registerOperation(
      operation({
        name: "image.generate_ref2va",
        component: "image",
        resource: "gpu",
        execute: async (context) => {
          const prompt = String(context.params["prompt"]);
          started.push(prompt);
          runningGpu += 1;
          mostGpu = Math.max(mostGpu, runningGpu);
          await gates.get(prompt)?.promise;
          runningGpu -= 1;
          return { outputs: [] };
        },
      }),
    );
    m.runner.registerOperation(
      operation({
        name: "batch.item_insert",
        component: "batch",
        execute: (context) => {
          started.push(String(context.params["prompt"]));
          return Promise.resolve({ outputs: [] });
        },
      }),
    );

    await schedule(m, project, "image.generate_ref2va", "gpu 1");
    const second = await schedule(m, project, "image.generate_ref2va", "gpu 2");
    const edit = await schedule(m, project, "batch.item_insert", "edit");

    await vi.waitFor(() => {
      expect(m.store.getRecord(project, edit.id).status).toBe("done");
    });
    expect(started).toEqual(["gpu 1", "edit"]);
    expect(m.store.getRecord(project, second.id).status).toBe("pending");
    gates.get("gpu 1")?.resolve();
    await vi.waitFor(() => {
      expect(started).toEqual(["gpu 1", "edit", "gpu 2"]);
    });
    gates.get("gpu 2")?.resolve();
    await m.scheduler.wait(project);
    expect(mostGpu).toBe(1);
  });

  it("fails a record whose input record failed", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const held = gate();
    const executed: string[] = [];
    m.runner.registerOperation(
      operation({
        name: "image.generate_ref2va",
        component: "image",
        execute: async (context) => {
          executed.push(String(context.params["prompt"]));
          await held.promise;
          throw new Error("The generator ran out of memory.");
        },
      }),
    );

    const a = await schedule(m, project, "image.generate_ref2va", "A");
    const b = await schedule(m, project, "image.generate_ref2va", "B", {
      inputs: [{ role: "reference", ref: { record: a.id, output: 0 } }],
    });
    held.resolve();
    await m.scheduler.wait(project);

    expect(m.store.getRecord(project, a.id)).toMatchObject({
      status: "failed",
      error: { code: "operation_failed" },
    });
    const failed = m.store.getRecord(project, b.id);
    expect(failed).toMatchObject({ status: "failed", error: { code: "input_failed" } });
    expect(failed.error?.message).toContain(a.id);
    expect(executed).toEqual(["A"]);
  });

  it("does not wait for the producers of pending input roles", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const held = gate();
    const seen: Array<string | null> = [];
    m.runner.registerOperation(
      operation({
        name: "image.generate_ref2va",
        component: "image",
        execute: async () => {
          await held.promise;
          throw new Error("The generator ran out of memory.");
        },
      }),
    );
    m.runner.registerOperation(
      operation({
        name: "batch.create",
        component: "batch",
        pendingInputRoles: ["reference"],
        execute: (context) => {
          seen.push(...context.inputs.map((input) => input.resolved_asset));
          return Promise.resolve({ outputs: [] });
        },
      }),
    );
    const gen = await schedule(m, project, "image.generate_ref2va", "A");
    const inputs = [{ role: "reference", ref: { record: gen.id, output: 0 } }];

    // Without `after`, the call executes at once; with `after`, it starts before the generation finishes.
    const immediate = await m.runner.run({
      project,
      operation: "batch.create",
      params: {},
      inputs,
      ...userOrigin(),
    });
    expect(immediate.record).toMatchObject({ status: "done", inputs: [{ resolved_asset: null }] });
    const scheduled = await schedule(m, project, "batch.create", "B", { inputs });
    await m.scheduler.wait(project, [scheduled.id]);
    expect(m.store.getRecord(project, gen.id).status).toBe("running");

    // The generation's failure leaves both calls done.
    held.resolve();
    await m.scheduler.wait(project);
    expect(m.store.getRecord(project, gen.id).status).toBe("failed");
    expect(m.store.getRecord(project, scheduled.id).status).toBe("done");
    expect(seen).toEqual([null, null]);
  });

  it("waits for every scheduled record of a project", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const followUps: RecordId[] = [];
    m.runner.registerOperation(
      operation({
        name: "image.batch",
        component: "image",
        // The call schedules one more record while it runs.
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const scheduled = await m.runner.run({
            project,
            operation: "image.generate_ref2va",
            params: { prompt: "image 1" },
            inputs: [],
            after: [],
            ...userOrigin(),
            actor: "system",
          });
          followUps.push(defined(scheduled.record, "the follow-up record").id);
          return { outputs: [] };
        },
      }),
    );
    m.runner.registerOperation(
      operation({
        name: "image.generate_ref2va",
        component: "image",
        resource: "gpu",
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { outputs: [importVariant(context)] };
        },
      }),
    );

    const batch = await schedule(m, project, "image.batch", "batch 1");
    await m.scheduler.wait(project);

    expect(m.store.getRecord(project, batch.id).status).toBe("done");
    expect(followUps).toHaveLength(1);
    expect(m.store.getRecord(project, defined(followUps[0], "the follow-up")).status).toBe("done");
    await expect(m.scheduler.wait(project, [batch.id])).resolves.toBeUndefined();
    await expect(
      m.scheduler.wait(project, [brandString<RecordId>("no-such-record")]),
    ).rejects.toMatchObject({ code: "unknown_record" });
  });
});
