/**
 * Tests of the operation runner: recorded runs, refusals before any write, failures, deterministic reuse, read-only
 * operations, the lock scope during execution, and the recovery of records an earlier process left unfinished.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it, vi } from "vitest";
import type { ProjectModules } from "./testing/support.ts";
import {
  agentOrigin,
  createTestProject,
  readLines,
  startModules,
  userOrigin,
} from "./testing/support.ts";
import type { OperationSpec } from "./operation-types.ts";
import { RecordStore } from "./record-store.ts";
import { projReducer, ReducerRegistry } from "./reducers.ts";
import { Runner } from "./runner.ts";
import { Scheduler } from "./scheduler.ts";
import type { AssetId, ProjectId, ProjectRecord, RecordOrigin, RunRequest } from "./types.ts";

declare module "@cs/project" {
  interface ComponentStates {
    /** The slice of the test setting outside the history: the `prompt` of each choice, in write order. */
    runner_setting?: { values: string[] };
  }
}

/**
 * An operation spec with test defaults: one optional `prompt` and `seed` parameter, the `reference` input role, not
 * deterministic, unlimited resource, and an execute function that creates nothing.
 * @param overrides - the fields to set; `name` and `component` are required.
 * @returns the spec.
 */
function operation(
  overrides: Partial<OperationSpec> & Pick<OperationSpec, "name" | "component">,
): OperationSpec {
  return {
    version: "1",
    params: { prompt: { type: "string" }, seed: { type: "integer" } },
    inputs: { reference: { type: "image", description: "A reference.", many: true } },
    outputs: [],
    description: "A test operation.",
    summarize: () => "ran",
    deterministic: false,
    resource: "none",
    execute: () => Promise.resolve({ outputs: [] }),
    ...overrides,
  };
}

/**
 * A run request with test defaults.
 * @param project - the project.
 * @param name - the operation name.
 * @param origin - who runs it.
 * @param extra - other request fields.
 * @returns the request.
 */
function request(
  project: ProjectId,
  name: string,
  origin: RecordOrigin = userOrigin(),
  extra: Partial<RunRequest> = {},
): RunRequest {
  return {
    project,
    operation: name,
    params: { prompt: "a red kite" },
    inputs: [],
    ...origin,
    ...extra,
  };
}

/** @returns a promise with its resolve function, for holding an execute or an approval until the test releases it. */
function gate<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @returns the text of the project's `records.jsonl`.
 */
function files(m: ProjectModules, project: ProjectId): string {
  return readFileSync(join(m.root, project, ".comfy-studio", "records.jsonl"), "utf8");
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @param name - an operation name.
 * @returns the project's records of that operation, in write order.
 */
function recordsOf(m: ProjectModules, project: ProjectId, name: string): ProjectRecord[] {
  return m.store.listRecords(project).filter((record) => record.operation === name);
}

describe("Runner", () => {
  it("runs an operation and records its outputs", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    m.runner.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        resource: "gpu",
        execute: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const variant = context.importAsset(Buffer.from("variant of a red kite"), {
            mime: "video/mp4",
            name: "variant.mp4",
            durationSec: 2,
          });
          return { outputs: [variant], report: { seed: 7 } };
        },
      }),
    );

    const result = await m.runner.run(request(project, "image.generate"));

    const record = result.record;
    expect(record?.status).toBe("done");
    expect(record?.outputs).toHaveLength(1);
    expect(result.outputs).toEqual(record?.outputs);
    expect(result.report).toEqual({ seed: 7 });
    expect(record?.report).toEqual({ seed: 7 });
    expect(record?.cost?.reused).toBe(false);
    expect(record?.cost?.wall_seconds).toBeGreaterThan(0);
    expect(m.assets.created.get(record?.outputs[0] as AssetId)).toBe(record?.id);
    const lines = readLines(m.root, project).filter(
      (line) => line["id"] === record?.id || line["update"] === record?.id,
    );
    expect(lines.map((line) => line["status"])).toEqual(["pending", "running", "done"]);
  });

  it("adds the records an operation replaces to the record's supersedes", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    m.runner.registerOperation(operation({ name: "batch.item_insert", component: "batch" }));
    const first = (await m.runner.run(request(project, "batch.item_insert"))).record!;
    const second = (await m.runner.run(request(project, "batch.item_insert"))).record!;
    const seen: string[] = [];
    // The spec replaces the head of the state it is given, which is the project's state before the call.
    m.runner.registerOperation(
      operation({
        name: "library.character_update",
        component: "library",
        supersedes: (params, state) => {
          seen.push(String(params.prompt));
          return [state.head];
        },
      }),
    );
    const update = await m.runner.run(
      request(project, "library.character_update", userOrigin(), {
        supersedes: [first.id, second.id],
      }),
    );
    expect(seen).toEqual(["a red kite"]);
    expect(update.record?.supersedes).toEqual([first.id, second.id]);
    const next = await m.runner.run(request(project, "library.character_update"));
    expect(next.record?.supersedes).toEqual([update.record?.id]);
  });

  it("sets based_on from the operation when the caller names none, and keeps the caller's based_on", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    m.runner.registerOperation(operation({ name: "batch.item_insert", component: "batch" }));
    const first = (await m.runner.run(request(project, "batch.item_insert"))).record!;
    // The spec copies the head of the state it is given, which is the project's state before the call.
    m.runner.registerOperation(
      operation({
        name: "library.character_update",
        component: "library",
        basedOn: (_params, state) => state.head,
      }),
    );
    const copied = await m.runner.run(request(project, "library.character_update"));
    expect(copied.record?.based_on).toBe(first.id);
    const named = await m.runner.run(
      request(project, "library.character_update", userOrigin(), { based_on: first.id }),
    );
    expect(named.record?.based_on).toBe(first.id);
    const unset = await m.runner.run(request(project, "batch.item_insert"));
    expect(unset.record?.based_on).toBeNull();
  });

  it("copies started_by from the request onto the record of a run or a scheduled run", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    m.runner.registerOperation(operation({ name: "batch.item_insert", component: "batch" }));
    const starter = (await m.runner.run(request(project, "batch.item_insert"))).record!;
    const startedBy = { record: starter.id, slot: 1, lane: "wide" };

    const now = await m.runner.run(
      request(project, "batch.item_insert", userOrigin(), { started_by: startedBy }),
    );
    const scheduled = { started_by: { record: starter.id, slot: null }, after: [] };
    const later = await m.runner.run(
      request(project, "batch.item_insert", userOrigin(), scheduled),
    );

    expect(starter).not.toHaveProperty("started_by");
    expect(now.record?.started_by).toEqual(startedBy);
    expect(later.record?.started_by).toEqual({ record: starter.id, slot: null });
    expect(
      readLines(m.root, project).find((line) => line["id"] === now.record?.id)?.["started_by"],
    ).toEqual(startedBy);
    await vi.waitFor(() => {
      expect(m.store.getRecord(project, later.record!.id).status).toBe("done");
    });
  });

  it("refuses invalid params, unknown inputs and unfinished inputs before writing", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const held = gate();
    m.runner.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        execute: async (context) => {
          await held.promise;
          return {
            outputs: [
              context.importAsset(Buffer.from("variant"), {
                mime: "video/mp4",
                name: "variant.mp4",
              }),
            ],
          };
        },
      }),
    );
    const running = m.runner.run(request(project, "image.generate"));
    await vi.waitFor(() => {
      expect(recordsOf(m, project, "image.generate")[0]?.status).toBe("running");
    });
    const producer = recordsOf(m, project, "image.generate")[0] as ProjectRecord;
    const before = files(m, project);
    const eventCount = m.events.length;

    // Agent calls are refused the same way.
    const agent = agentOrigin();
    const refusals: Array<[Partial<RunRequest>, string]> = [
      [{ params: { prompt: 5 } }, "invalid_params"],
      [{ inputs: [{ role: "mask", ref: { asset: m.assets.add("mask") } }] }, "invalid_inputs"],
      [
        { inputs: [{ role: "reference", ref: { asset: brandString<AssetId>("no-such-asset") } }] },
        "unknown_asset",
      ],
      [
        { inputs: [{ role: "reference", ref: { record: producer.id, output: 0 } }] },
        "input_not_ready",
      ],
    ];
    for (const [extra, code] of refusals) {
      await expect(
        m.runner.run(request(project, "image.generate", agent, extra)),
      ).rejects.toMatchObject({ code });
    }
    await expect(m.runner.run(request(project, "unregistered", agent))).rejects.toMatchObject({
      code: "unknown_operation",
    });

    expect(files(m, project)).toBe(before);
    expect(m.events).toHaveLength(eventCount);
    held.resolve();
    expect((await running).record?.status).toBe("done");
  });

  it("refuses a call that the operation's precondition refuses, before writing", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const seen: string[] = [];
    const precondition = (call: RunRequest, state: { head: string }): Promise<void> => {
      seen.push(state.head);
      return call.params["prompt"] === "refuse"
        ? Promise.reject(new Error("This generation has no reference image."))
        : Promise.resolve();
    };
    m.runner.registerOperation(
      operation({ name: "image.generate", component: "image", precondition }),
    );
    m.runner.registerOperation(
      operation({ name: "inspect.image", component: "inspect", readOnly: true, precondition }),
    );
    const before = files(m, project);
    const head = m.store.line(project)?.at;
    const eventCount = m.events.length;

    // An agent call that is refused writes nothing; a read-only call is refused the same way.
    for (const name of ["image.generate", "inspect.image"]) {
      await expect(
        m.runner.run(request(project, name, agentOrigin(), { params: { prompt: "refuse" } })),
      ).rejects.toThrow("This generation has no reference image.");
    }
    expect(files(m, project)).toBe(before);
    expect(m.events).toHaveLength(eventCount);
    expect(seen).toEqual([head, head]);
    expect((await m.runner.run(request(project, "image.generate"))).record?.status).toBe("done");
  });

  it("checks a call with the sentence that run refuses it with, writing nothing", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    m.runner.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        precondition: (call) =>
          call.params["prompt"] === "refuse"
            ? Promise.reject(new Error("This generation has no reference image."))
            : Promise.resolve(),
      }),
    );
    const before = files(m, project);
    const calls: Array<Partial<RunRequest>> = [
      { params: { prompt: 5 } },
      { inputs: [{ role: "mask", ref: { asset: m.assets.add("mask") } }] },
      { inputs: [{ role: "reference", ref: { asset: brandString<AssetId>("no-such-asset") } }] },
      { params: { prompt: "refuse" } },
    ];
    for (const extra of calls) {
      const refusal = await m.runner
        .run(request(project, "image.generate", userOrigin(), extra))
        .then(
          () => "",
          (error: unknown) => (error as Error).message,
        );
      expect(refusal).not.toBe("");
      expect(await m.runner.check(request(project, "image.generate", userOrigin(), extra))).toEqual(
        {
          problems: [refusal],
        },
      );
    }
    expect(await m.runner.check(request(project, "unregistered"))).toEqual({
      problems: ["Operation unregistered is not registered."],
    });
    expect(
      await m.runner.check(
        request(project, "image.generate", userOrigin(), { params: { prompt: "a kite", seed: 2 } }),
      ),
    ).toEqual({ problems: [] });
    expect(files(m, project)).toBe(before);
  });

  it("refuses a read whose input names a record that has not finished, even with after, and runs nothing", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const held = gate();
    m.runner.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        execute: async (context) => {
          await held.promise;
          return {
            outputs: [
              context.importAsset(Buffer.from("variant"), {
                mime: "video/mp4",
                name: "variant.mp4",
              }),
            ],
          };
        },
      }),
    );
    const read = vi.fn(() => Promise.resolve({ outputs: [] }));
    m.runner.registerOperation(
      operation({ name: "inspect.image", component: "inspect", readOnly: true, execute: read }),
    );
    const running = m.runner.run(request(project, "image.generate"));
    await vi.waitFor(() => {
      expect(recordsOf(m, project, "image.generate")[0]?.status).toBe("running");
    });
    const producer = recordsOf(m, project, "image.generate")[0] as ProjectRecord;
    const call = request(project, "inspect.image", userOrigin(), {
      inputs: [{ role: "reference", ref: { record: producer.id, output: 0 } }],
      after: [],
    });
    await expect(m.runner.run(call)).rejects.toMatchObject({ code: "input_not_ready" });
    expect([read.mock.calls.length, (await m.runner.check(call)).problems]).toEqual([
      0,
      [expect.stringContaining(producer.id)],
    ]);
    held.resolve();
    await running;
  });

  it("fails the record when execute throws", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    m.runner.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        execute: () => Promise.reject(new Error("The generator ran out of memory.")),
      }),
    );

    const result = await m.runner.run(request(project, "image.generate"));

    expect(result.record).toMatchObject({
      status: "failed",
      error: { code: "operation_failed", message: "The generator ran out of memory." },
    });
    expect(result.outputs).toEqual([]);
    expect(
      m.store.getRecord(project, result.record?.id as ProjectRecord["id"]).finished_at,
    ).toBeDefined();
  });

  it("reuses outputs of an identical deterministic call", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    let calls = 0;
    m.runner.registerOperation(
      operation({
        name: "asset.crop",
        component: "asset",
        deterministic: true,
        execute: (context) => {
          calls += 1;
          const still = context.importAsset(Buffer.from(`still ${String(calls)}`), {
            mime: "image/png",
            name: "still.png",
          });
          return Promise.resolve({ outputs: [still] });
        },
      }),
    );
    const video = m.assets.add("a video");
    const inputs: RunRequest["inputs"] = [{ role: "reference", ref: { asset: video } }];

    const first = await m.runner.run(
      request(project, "asset.crop", userOrigin(), {
        params: { prompt: "frame", seed: 1 },
        inputs,
      }),
    );
    const second = await m.runner.run(
      request(project, "asset.crop", userOrigin(), {
        params: { seed: 1, prompt: "frame" },
        inputs,
      }),
    );

    expect(calls).toBe(1);
    expect(second.record).toMatchObject({
      status: "done",
      cost: { wall_seconds: 0, reused: true },
    });
    expect(second.outputs).toEqual(first.outputs);
    expect(second.record?.started_at).toBeUndefined();
  });

  it("writes no record for a read-only operation", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const seen: Array<ProjectRecord | null> = [];
    m.runner.registerOperation(
      operation({
        name: "inspect.image",
        component: "inspect",
        readOnly: true,
        execute: (context) => {
          seen.push(context.record);
          return Promise.resolve({ outputs: [], report: { caption: "a red kite over a beach" } });
        },
      }),
    );
    const before = files(m, project);

    const result = await m.runner.run(
      request(project, "inspect.image", agentOrigin(), {
        inputs: [{ role: "reference", ref: { asset: m.assets.add("an image") } }],
      }),
    );

    expect(result).toEqual({
      record: null,
      outputs: [],
      report: { caption: "a red kite over a beach" },
    });
    expect(seen).toEqual([null]);
    expect(files(m, project)).toBe(before);
  });

  it("records a setting outside the history without a step, and folds it whatever the current position", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    m.runner.registerComponent("runner_setting");
    m.reducers.register("runner_setting", {
      initial: () => ({ values: [] }),
      reduce: (slice, record) =>
        record.operation === "runner_setting.choose"
          ? { values: [...(slice?.values ?? []), String(record.params.prompt)] }
          : slice,
    });
    m.runner.registerOperation(
      operation({
        name: "runner_setting.choose",
        component: "runner_setting",
        outsideHistory: true,
      }),
    );
    // A setting of a component without a reducer changes no slice.
    m.runner.registerOperation(
      operation({ name: "image.load", component: "image", outsideHistory: true }),
    );
    m.runner.registerOperation(operation({ name: "image.generate", component: "image" }));
    const step = await m.runner.run(request(project, "image.generate"));
    await m.store.lock(project, () => m.history.undo(project));
    const line = m.store.line(project);
    const events = m.events.length;

    const chosen = await m.runner.run(
      request(project, "runner_setting.choose", userOrigin(), { params: { prompt: "pika" } }),
    );
    await m.runner.run(request(project, "image.load"));

    expect(chosen.record?.status).toBe("done");
    expect(m.store.line(project)).toEqual(line);
    expect(m.events.slice(events).some(({ event }) => event.kind === "line")).toBe(false);
    expect(m.history.list({ project }).map((entry) => entry.record.operation)).toEqual([
      "image.generate",
      "proj.create",
    ]);
    expect(m.reducers.getState(project).components.runner_setting).toEqual({ values: ["pika"] });
    await m.store.lock(project, () => m.history.redo(project));
    expect(m.store.line(project)?.at).toBe(step.record?.id);
    expect(m.reducers.getState(project).components.runner_setting).toEqual({ values: ["pika"] });
  });

  it("registers an operation only after a plugin registers its component", () => {
    const m = startModules();
    expect(() =>
      m.runner.registerOperation(operation({ name: "preset.make", component: "preset" })),
    ).toThrow(expect.objectContaining({ code: "invalid_params" }));
    const disposeComponent = m.runner.registerComponent("preset");
    expect(() => m.runner.registerComponent("preset")).toThrow(
      expect.objectContaining({ code: "component_exists" }),
    );
    m.runner.registerOperation(operation({ name: "preset.make", component: "preset" }));
    expect(m.runner.listOperations().map((spec) => spec.name)).toEqual(["preset.make"]);
    disposeComponent();
    m.runner.registerComponent("preset");
  });

  it("refuses a second operation with a registered name until the first one is removed", () => {
    const m = startModules();
    const dispose = m.runner.registerOperation(
      operation({ name: "image.generate", component: "image" }),
    );
    expect(() =>
      m.runner.registerOperation(operation({ name: "image.generate", component: "image" })),
    ).toThrow(expect.objectContaining({ code: "operation_exists" }));
    dispose();
    m.runner.registerOperation(operation({ name: "image.generate", component: "image" }));
    expect(m.runner.listOperations().map((spec) => spec.name)).toEqual(["image.generate"]);
  });

  it("refuses an operation whose name does not start with its component key", () => {
    const m = startModules();
    expect(() =>
      m.runner.registerOperation(operation({ name: "batch.create", component: "inspect" })),
    ).toThrow(expect.objectContaining({ code: "invalid_params" }));
    expect(() =>
      m.runner.registerOperation(operation({ name: "image", component: "image" })),
    ).toThrow(expect.objectContaining({ code: "invalid_params" }));
    expect(m.runner.listOperations()).toEqual([]);
  });

  it("lets other edits run while a generation executes", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const held = gate();
    m.runner.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        resource: "gpu",
        execute: async () => {
          await held.promise;
          return { outputs: [] };
        },
      }),
    );
    m.runner.registerOperation(operation({ name: "batch.item_insert", component: "batch" }));

    const gen = m.runner.run(request(project, "image.generate"));
    await vi.waitFor(() => {
      expect(recordsOf(m, project, "image.generate")[0]?.status).toBe("running");
    });
    const edit = await m.runner.run(request(project, "batch.item_insert"));

    expect(edit.record?.status).toBe("done");
    expect(recordsOf(m, project, "image.generate")[0]?.status).toBe("running");
    held.resolve();
    expect((await gen).record?.status).toBe("done");
  });

  it("loads a stored log whose operations and reference kind have no owner, and refuses a new call with that version", async () => {
    const m = startModules();
    // The stored shapes of real logs: an old generation name that no operation has, a `deliver.batch_export` record whose
    // component no plugin registers, and an input `{character, version}` of a reference kind that no plugin registers.
    const project = brandString<ProjectId>("stored-project");
    const face = m.assets.add("face");
    const variant = m.assets.add("variant");
    const origin = {
      ...userOrigin(),
      operation_version: "1",
      based_on: null,
      supersedes: [],
      deterministic: false,
      status: "done",
    };
    const lines = [
      {
        ...origin,
        id: "r1",
        parents: [],
        kind: "operation",
        component: "proj",
        operation: "proj.create",
        params: { title: "Old" },
        inputs: [],
        outputs: [],
        created_at: "2026-10-07T23:40:00.000Z",
      },
      {
        ...origin,
        id: "r2",
        parents: ["r1"],
        kind: "operation",
        component: "image",
        operation: "image.generate_ref2va",
        params: { prompt: "dance" },
        outputs: [variant],
        created_at: "2026-10-07T23:41:00.000Z",
        inputs: [{ role: "reference", ref: { character: "c1", version: 1 }, resolved_asset: face }],
      },
      {
        ...origin,
        id: "r3",
        parents: ["r2"],
        kind: "operation",
        component: "deliver",
        operation: "deliver.batch_export",
        params: { batch: "t1" },
        inputs: [],
        outputs: [],
        created_at: "2026-10-07T23:42:00.000Z",
      },
    ];
    mkdirSync(join(m.root, project, ".comfy-studio"), { recursive: true });
    writeFileSync(
      join(m.root, project, ".comfy-studio", "records.jsonl"),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    m.folders.add(project, "Old");

    // Replay passes every record through the registered reducers only; the unowned version is no producer.
    const proj = m.reducers.getState(project).components.proj;
    expect(proj.records.map((record) => record.operation)).toEqual([
      "proj.create",
      "image.generate_ref2va",
      "deliver.batch_export",
    ]);
    expect(proj.stale).toEqual({});
    m.runner.registerOperation(operation({ name: "image.generate", component: "image" }));
    // The new call reads the stored `{character, version}` reference of the old generation.
    const reads = { inputs: [{ role: "reference", ref: proj.records[1]!.inputs[0]!.ref }] };
    await expect(
      m.runner.run(request(project, "image.generate", userOrigin(), reads)),
    ).rejects.toMatchObject({ code: "invalid_inputs" });
    expect(recordsOf(m, project, "image.generate")).toEqual([]);
  });

  it("ends unfinished records at start", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    // An earlier process wrote one pending and one running record, then stopped.
    const unfinished = await m.store.lock(project, () =>
      ["pending", "running"].map((status) => {
        const head = m.store.line(project)!.at;
        const record = m.store.append(project, {
          parents: [head],
          kind: "operation",
          component: "image",
          operation: "image.generate",
          operation_version: "1",
          ...userOrigin(),
          params: {},
          inputs: [],
          outputs: [],
          based_on: null,
          supersedes: [],
          deterministic: false,
          status: "pending",
        });
        return status === "running"
          ? m.store.update(project, { update: record.id, status: "running" })
          : record;
      }),
    );

    // A new process loads the same root and recovers.
    const store = new RecordStore(m.folders, () => undefined);
    const holder: { runner: Runner | null } = { runner: null };
    const reducers = new ReducerRegistry(
      store,
      (record) => holder.runner?.isOutsideHistory(record) ?? false,
    );
    const scheduler = new Scheduler(
      store,
      (id, record) => (holder.runner as Runner).execute(id, record),
      { cpu: 1, gpu: 1 },
    );
    holder.runner = new Runner({ store, reducers, scheduler, assets: m.assets });
    reducers.register("proj", projReducer);
    await holder.runner.recover();
    scheduler.dispose();

    for (const record of unfinished) {
      expect(store.getRecord(project, record.id)).toMatchObject({
        status: "cancelled",
        error: { code: "stopped", message: "The server stopped before the call finished." },
      });
    }
    expect(
      readLines(m.root, project).filter((line) => line["status"] === "cancelled"),
    ).toHaveLength(2);
  });
});
