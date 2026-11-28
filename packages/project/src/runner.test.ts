/**
 * Tests of the operation runner: recorded runs, refusals before any write, failures, deterministic reuse, read-only
 * operations, the lock scope during execution, and the recovery of records an earlier process left unfinished.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ProjectModules } from "./testing/support.ts";
import {
  agentOrigin,
  asError,
  createTestProject,
  defined,
  readLines,
  STAND_IN_COMPONENTS,
  startModules,
  userOrigin,
} from "./testing/support.ts";
import type { OperationSpec } from "./operation-types.ts";
import { RecordStore } from "./record-store.ts";
import { projReducer, ReducerRegistry } from "./reducers.ts";
import { Runner } from "./runner.ts";
import { Scheduler } from "./scheduler.ts";
import { OperationFailure, ProjectError } from "./shared.ts";
import type {
  AgentCall,
  AssetId,
  ProjectId,
  ProjectRecord,
  ProjectState,
  RecordId,
  RecordOrigin,
  RunRequest,
} from "./types.ts";

declare module "@cs/project/types" {
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
 * @param role - an input role.
 * @param asset - an asset.
 * @returns a run input that gives the asset to the role.
 */
function assetInput(role: string, asset: AssetId): RunRequest["inputs"][number] {
  return { role, ref: { asset } };
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

/** A placeholder that a test replaces once the real function exists. */
const noop = (): void => undefined;

/** @returns a promise with its resolve function, for holding an execute or an approval until the test releases it. */
function gate<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Register the `runner_setting` component: its reducer keeps the `prompt` of every `runner_setting.choose` record, a
 * user-only setting outside the history.
 * @param m - the modules.
 */
function registerSetting(m: ProjectModules): void {
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
      agent: "none",
    }),
  );
}

/**
 * Choose a setting as the user.
 * @param m - the modules.
 * @param project - the project.
 * @param value - the `prompt` of the choice.
 */
async function choose(m: ProjectModules, project: ProjectId, value: string): Promise<void> {
  await m.runner.run(
    request(project, "runner_setting.choose", userOrigin(), { params: { prompt: value } }),
  );
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
    expect(m.assets.created.get(defined(record?.outputs[0], "the output asset"))).toBe(record?.id);
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
    const producer = defined(recordsOf(m, project, "image.generate")[0], "the producer record");
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
          (error: unknown) => asError(error, Error).message,
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
    const producer = defined(recordsOf(m, project, "image.generate")[0], "the producer record");
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
      m.store.getRecord(project, defined(result.record?.id, "the result record")).finished_at,
    ).toBeDefined();
  });

  it("fails the record with the code of a thrown OperationFailure", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    m.runner.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        execute: () =>
          Promise.reject(new OperationFailure("not_queued", "The server refused the graph.")),
      }),
    );

    const result = await m.runner.run(request(project, "image.generate"));

    expect(result.record).toMatchObject({
      status: "failed",
      error: { code: "not_queued", message: "The server refused the graph." },
    });
    for (const code of [
      "operation_failed",
      "input_failed",
      "stopped",
      "discarded",
      "Not Queued",
      "",
    ])
      expect(() => new OperationFailure(code, "no")).toThrow(TypeError);
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

  it("reuses a deterministic call only when each role gets the same assets in the same order", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    let calls = 0;
    m.runner.registerOperation(
      operation({
        name: "asset.crop",
        component: "asset",
        deterministic: true,
        inputs: {
          image: { type: "image", description: "The image.", many: true },
          mask: { type: "image", description: "The mask." },
        },
        execute: (context) => {
          calls += 1;
          const made = context.importAsset(Buffer.from(`made ${String(calls)}`), {
            mime: "image/png",
            name: "made.png",
          });
          return Promise.resolve({ outputs: [made] });
        },
      }),
    );
    const a = m.assets.add("asset a");
    const b = m.assets.add("asset b");
    const c = m.assets.add("asset c");
    const run = (inputs: RunRequest["inputs"]) =>
      m.runner.run(request(project, "asset.crop", userOrigin(), { params: { seed: 1 }, inputs }));
    const first = await run([
      assetInput("image", a),
      assetInput("image", b),
      assetInput("mask", c),
    ]);
    // The same assets, with the roles named in another order: the same call.
    const sameCall = await run([
      assetInput("mask", c),
      assetInput("image", a),
      assetInput("image", b),
    ]);
    expect(calls).toBe(1);
    expect(sameCall.record?.cost).toEqual({ wall_seconds: 0, reused: true });
    expect(sameCall.outputs).toEqual(first.outputs);

    // The same assets in other roles, or in another order within a role: other calls, which execute.
    const swappedRoles = await run([
      assetInput("image", a),
      assetInput("image", c),
      assetInput("mask", b),
    ]);
    const swappedOrder = await run([
      assetInput("image", b),
      assetInput("image", a),
      assetInput("mask", c),
    ]);
    expect(calls).toBe(3);
    expect(swappedRoles.record?.cost?.reused).toBe(false);
    expect(swappedOrder.record?.cost?.reused).toBe(false);
    expect(swappedRoles.outputs).not.toEqual(first.outputs);
    expect(swappedOrder.outputs).not.toEqual(first.outputs);
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
      (id, record) => defined(holder.runner, "the runner").execute(id, record),
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

/**
 * An `agent` function that reads the last `runner_setting` choice: `run` or `none` as chosen, else `propose`.
 * @param state - the project's state.
 * @returns the agent call.
 */
function bySetting(state: ProjectState): AgentCall {
  const last = state.components.runner_setting?.values.at(-1);
  return last === "run" || last === "none" ? last : "propose";
}

describe("an agent call decided by the project's state", () => {
  it("refuses an agent's run and check by the state at the call, writing nothing, and runs it for the user", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    registerSetting(m);
    const states: string[] = [];
    m.runner.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        agent: (state) => {
          states.push(state.head);
          return bySetting(state);
        },
      }),
    );
    const call = request(project, "image.generate", agentOrigin());
    const refusal = async (): Promise<ProjectError> =>
      asError(await m.runner.run(call).catch((error: unknown) => error), ProjectError);

    // No choice yet: the call proposes, so an agent's run is refused, and so is its check.
    const before = files(m, project);
    const proposing = await refusal();
    expect(proposing.code).toBe("agent_not_allowed");
    expect(proposing.message).toContain("proposes the call");
    expect((await m.runner.check(call)).problems).toEqual([proposing.message]);
    expect(files(m, project)).toBe(before);
    // The function was asked with the project's current state.
    expect(states.every((head) => head === m.store.line(project)?.at)).toBe(true);

    // The user turns agent runs on: the same call runs.
    await choose(m, project, "run");
    expect(await m.runner.check(call)).toEqual({ problems: [] });
    expect((await m.runner.run(call)).record).toMatchObject({ actor: "agent", status: "done" });

    // The user turns agent calls off: the call is refused as for an operation without a tool.
    await choose(m, project, "none");
    const off = await refusal();
    expect(off.code).toBe("agent_not_allowed");
    expect(off.message).toContain("only the user runs it");
    // The user's run never asks the function.
    states.length = 0;
    expect((await m.runner.run(request(project, "image.generate"))).record?.status).toBe("done");
    expect(states).toEqual([]);
  });

  it("refuses to register a read whose agent call is a function", () => {
    const m = startModules();
    expect(() =>
      m.runner.registerOperation(
        operation({ name: "inspect.look", component: "inspect", readOnly: true, agent: bySetting }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_params" }));
    expect(m.runner.listOperations()).toEqual([]);
  });
});

describe("background operations", () => {
  it("schedules every call, returns the pending record at once, and finishes it without the request's signal", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const held = gate();
    let signal: AbortSignal | null = null;
    m.runner.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        resource: "gpu",
        background: true,
        execute: async (context) => {
          signal = context.signal;
          await held.promise;
          return { outputs: [], report: { seed: 3 } };
        },
      }),
    );
    const turn = new AbortController();
    const result = await m.runner.run(
      request(project, "image.generate", agentOrigin(), { signal: turn.signal }),
    );
    expect(result).toEqual({
      record: expect.objectContaining({ status: "pending" }),
      outputs: [],
      report: null,
    });
    const id = defined(result.record).id;
    const seen = await vi.waitFor(() => defined<AbortSignal>(signal, "the operation's signal"));
    expect(m.store.getRecord(project, id).status).toBe("running");
    // The turn ends; the background run goes on.
    turn.abort();
    expect(seen.aborted).toBe(false);
    held.resolve();
    await m.scheduler.wait(project, [id]);
    expect(m.store.getRecord(project, id)).toMatchObject({ status: "done", report: { seed: 3 } });
  });

  it("keeps the gpu and cpu limits for background runs", async () => {
    const m = startModules({ cpu: 1, gpu: 1 });
    const project = await createTestProject(m);
    const held = gate();
    const running = { gpu: 0, cpu: 0 };
    const most = { gpu: 0, cpu: 0 };
    for (const resource of ["gpu", "cpu"] as const) {
      m.runner.registerOperation(
        operation({
          name: `image.${resource}`,
          component: "image",
          resource,
          background: true,
          execute: async () => {
            running[resource] += 1;
            most[resource] = Math.max(most[resource], running[resource]);
            await held.promise;
            running[resource] -= 1;
            return { outputs: [] };
          },
        }),
      );
    }
    const ids: RecordId[] = [];
    for (const name of ["image.gpu", "image.gpu", "image.cpu", "image.cpu"]) {
      ids.push(defined((await m.runner.run(request(project, name))).record).id);
    }
    await vi.waitFor(() => {
      expect(running).toEqual({ gpu: 1, cpu: 1 });
    });
    expect(ids.map((id) => m.store.getRecord(project, id).status)).toEqual([
      "running",
      "pending",
      "running",
      "pending",
    ]);
    held.resolve();
    await m.scheduler.wait(project);
    expect(most).toEqual({ gpu: 1, cpu: 1 });
    expect(ids.map((id) => m.store.getRecord(project, id).status)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("refuses to register a background read or a background setting outside the history", () => {
    const m = startModules();
    for (const extra of [{ readOnly: true }, { outsideHistory: true }]) {
      expect(() =>
        m.runner.registerOperation(
          operation({ name: "image.later", component: "image", background: true, ...extra }),
        ),
      ).toThrow(expect.objectContaining({ code: "invalid_params" }));
    }
    expect(m.runner.listOperations()).toEqual([]);
  });
});

/**
 * A runner and scheduler over the folders of `m` whose scheduler waits for `started` before it executes each record it
 * starts, so that a test can reach a record that left the queue and has not begun executing.
 * @param m - the modules whose folders and assets the new ones share.
 * @param started - settles when the scheduler may execute the records it started.
 * @returns the store, the scheduler and the runner.
 */
function startGated(
  m: ProjectModules,
  started: Promise<void>,
): { store: RecordStore; scheduler: Scheduler; runner: Runner } {
  const holder: { scheduler: Scheduler | null; runner: Runner | null } = {
    scheduler: null,
    runner: null,
  };
  const store = new RecordStore(m.folders, (project, event) => {
    if (event.kind === "update" && ["done", "failed", "cancelled"].includes(event.record.status))
      holder.scheduler?.recordFinished(project);
  });
  const reducers = new ReducerRegistry(
    store,
    (record) => holder.runner?.isOutsideHistory(record) ?? false,
  );
  const scheduler = new Scheduler(
    store,
    async (project, record) => {
      await started;
      return await defined(holder.runner, "the runner").execute(project, record);
    },
    { cpu: 4, gpu: 1 },
  );
  const runner = new Runner({ store, reducers, scheduler, assets: m.assets });
  for (const key of STAND_IN_COMPONENTS) runner.registerComponent(key);
  reducers.register("proj", projReducer);
  holder.scheduler = scheduler;
  holder.runner = runner;
  onTestFinished(() => {
    scheduler.dispose();
  });
  return { store, scheduler, runner };
}

/**
 * The modules, a project, and `image.generate`: a background gpu operation (one at a time) that waits for `held`.
 * @param execute - the operation's execute instead of the default, which records its `prompt` and waits for `held`.
 * @returns the modules, the project, the gate and the prompts the default execute saw.
 */
async function startCancel(execute?: OperationSpec["execute"]): Promise<{
  m: ProjectModules;
  project: ProjectId;
  held: { promise: Promise<void>; resolve: () => void };
  executed: string[];
}> {
  const m = startModules({ cpu: 4, gpu: 1 });
  const project = await createTestProject(m);
  const held = gate();
  const executed: string[] = [];
  m.runner.registerOperation(
    operation({
      name: "image.generate",
      component: "image",
      resource: "gpu",
      background: true,
      execute:
        execute ??
        (async (context) => {
          executed.push(String(context.params["prompt"]));
          await held.promise;
          return { outputs: [] };
        }),
    }),
  );
  return { m, project, held, executed };
}

/**
 * Start `image.generate` as the user.
 * @param m - the modules.
 * @param project - the project.
 * @param prompt - the call's `prompt`.
 * @returns its pending record.
 */
async function generate(
  m: ProjectModules,
  project: ProjectId,
  prompt: string,
): Promise<ProjectRecord> {
  return defined(
    (await m.runner.run(request(project, "image.generate", userOrigin(), { params: { prompt } })))
      .record,
  );
}

/**
 * @param m - the modules.
 * @param record - a record.
 * @param from - the index of the first event to read.
 * @returns the status of each update event of the record since `from`.
 */
function updatesOf(m: ProjectModules, record: RecordId, from: number): string[] {
  return m.events
    .slice(from)
    .flatMap(({ event }) =>
      event.kind === "update" && event.record.id === record ? [event.record.status] : [],
    );
}

describe("cancel", () => {
  it("takes a queued record out of the queue and ends it, and fails the records that wait for it", async () => {
    const { m, project, held, executed } = await startCancel();
    const first = await generate(m, project, "first");
    const queued = await generate(m, project, "queued");
    m.runner.registerOperation(operation({ name: "batch.item_insert", component: "batch" }));
    const waiting = defined(
      (
        await m.runner.run(
          request(project, "batch.item_insert", userOrigin(), { after: [queued.id] }),
        )
      ).record,
    );
    await vi.waitFor(() => {
      expect(m.store.getRecord(project, first.id).status).toBe("running");
    });
    const line = m.store.line(project);
    const lines = readLines(m.root, project).length;
    const events = m.events.length;

    const stopped = await m.runner.cancel(project, queued.id, userOrigin({ intent: "stop" }));

    expect(stopped).toMatchObject({
      id: queued.id,
      status: "cancelled",
      error: { code: "stopped", message: "Stopped by the user." },
    });
    expect(stopped.finished_at).toBeDefined();
    expect(m.store.line(project)).toEqual(line);
    expect(
      m.events.slice(events).some(({ event }) => event.kind === "record" || event.kind === "line"),
    ).toBe(false);
    expect(updatesOf(m, queued.id, events)).toEqual(["cancelled"]);
    await m.scheduler.wait(project, [waiting.id]);
    expect(m.store.getRecord(project, waiting.id)).toMatchObject({
      status: "failed",
      error: {
        code: "input_failed",
        message: `Record ${queued.id}, which this call waits for, ended cancelled: Stopped by the user.`,
      },
    });
    // The running record goes on; the stopped one never executes.
    held.resolve();
    await m.scheduler.wait(project);
    expect(m.store.getRecord(project, first.id).status).toBe("done");
    expect(executed).toEqual(["first"]);
    // One update line each: the stopped record, the record that waited for it, and the first record's `done`.
    expect(readLines(m.root, project).length - lines).toBe(3);
  });

  it("aborts an executing record and resolves once it ended cancelled", async () => {
    let listening = false;
    const { m, project } = await startCancel(
      (context) =>
        new Promise((_resolve, reject) => {
          listening = true;
          context.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const record = await generate(m, project, "a");
    await vi.waitFor(() => {
      expect(listening).toBe(true);
    });
    const line = m.store.line(project);
    const events = m.events.length;
    expect(await m.runner.cancel(project, record.id, userOrigin())).toMatchObject({
      status: "cancelled",
      error: { code: "stopped", message: "Stopped by the user." },
    });
    expect(updatesOf(m, record.id, events)).toEqual(["cancelled"]);
    expect(m.store.line(project)).toEqual(line);
    // A second stop answers the finished record.
    expect((await m.runner.cancel(project, record.id, userOrigin())).status).toBe("cancelled");
    expect(updatesOf(m, record.id, events)).toEqual(["cancelled"]);
  });

  it("waits for an execution that ignores the signal, without holding the project, and keeps its done", async () => {
    const { m, project, held, executed } = await startCancel();
    const record = await generate(m, project, "a");
    await vi.waitFor(() => {
      expect(executed).toEqual(["a"]);
    });
    let settled = false;
    const stopping = m.runner.cancel(project, record.id, userOrigin()).then((ended) => {
      settled = true;
      return ended;
    });
    // While the stop waits, other edits of the project run.
    m.runner.registerOperation(operation({ name: "batch.item_insert", component: "batch" }));
    expect((await m.runner.run(request(project, "batch.item_insert"))).record?.status).toBe("done");
    expect(settled).toBe(false);
    held.resolve();
    expect(await stopping).toMatchObject({ id: record.id, status: "done" });
    expect(m.store.getRecord(project, record.id)).not.toHaveProperty("error");
  });

  it("ends a call stopped before its operation started without starting it", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const execute = vi.fn(() => Promise.resolve({ outputs: [] }));
    m.runner.registerOperation(operation({ name: "image.generate", component: "image", execute }));
    // The stop comes when the record is written, before the run reaches the operation.
    let stopping: Promise<ProjectRecord> | null = null;
    const unsubscribe = m.subscriptions.subscribe(project, (event) => {
      if (event.kind === "record" && event.record.operation === "image.generate")
        stopping = m.runner.cancel(project, event.record.id, userOrigin());
    });
    const result = await m.runner.run(request(project, "image.generate"));
    unsubscribe();
    expect(result.record).toMatchObject({
      status: "cancelled",
      error: { code: "stopped", message: "Stopped by the user." },
    });
    expect(await defined<Promise<ProjectRecord>>(stopping)).toEqual(result.record);
    expect(execute).not.toHaveBeenCalled();
  });

  it("ends a pending record that left the queue and has not begun executing, when it begins", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const started = gate();
    const gated = startGated(m, started.promise);
    const execute = vi.fn(() => Promise.resolve({ outputs: [] }));
    gated.runner.registerOperation(
      operation({ name: "image.generate", component: "image", background: true, execute }),
    );
    const pending = defined((await gated.runner.run(request(project, "image.generate"))).record);
    const stopping = gated.runner.cancel(project, pending.id, userOrigin());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gated.store.getRecord(project, pending.id).status).toBe("pending");
    started.resolve();
    expect(await stopping).toMatchObject({
      status: "cancelled",
      error: { code: "stopped", message: "Stopped by the user." },
    });
    expect(execute).not.toHaveBeenCalled();
    const lines = readLines(m.root, project).filter((line) => line["update"] === pending.id);
    expect(lines.map((line) => line["status"])).toEqual(["cancelled"]);
  });

  it("returns a finished record as it is, refuses an agent, and refuses unknown IDs", async () => {
    const { m, project, held } = await startCancel();
    m.runner.registerOperation(operation({ name: "batch.item_insert", component: "batch" }));
    const done = defined((await m.runner.run(request(project, "batch.item_insert"))).record);
    const running = await generate(m, project, "a");
    await vi.waitFor(() => {
      expect(m.store.getRecord(project, running.id).status).toBe("running");
    });
    const before = files(m, project);
    expect(await m.runner.cancel(project, done.id, userOrigin())).toEqual(done);
    const create = defined(m.store.listRecords(project)[0]);
    expect(await m.runner.cancel(project, create.id, userOrigin())).toEqual(create);
    const cases: Array<[ProjectId, RecordId, RecordOrigin, string]> = [
      [project, running.id, agentOrigin(), "agent_not_allowed"],
      [project, brandString<RecordId>("nope"), userOrigin(), "unknown_record"],
      [brandString<ProjectId>("elsewhere"), running.id, userOrigin(), "unknown_project"],
    ];
    for (const [where, id, origin, code] of cases) {
      const error = asError(
        await m.runner.cancel(where, id, origin).catch((e: unknown) => e),
        ProjectError,
      );
      expect(error.code).toBe(code);
    }
    expect(files(m, project)).toBe(before);
    held.resolve();
    await m.scheduler.wait(project);
    expect(m.store.getRecord(project, running.id).status).toBe("done");
  });
});
