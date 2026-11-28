/**
 * Tests of the proposal mechanism on the real modules: the `agent` field of operations as the runner enforces it,
 * `Runner.propose` (its checks, the record outside the history, the folding of repeated proposals), the `proposals`
 * of the `proj` slice across undo, redo and a reload, and `ProposalDecider.decide` (accept, reject, decided already,
 * in flight, a refusal before the run's record, a failed run, and refusals of the call itself).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it, vi } from "vitest";
import type { OperationSpec } from "./operation-types.ts";
import { DECIDE_OPERATION, PROPOSE_OPERATION, ProposalDecider } from "./proposals.ts";
import { RecordStore } from "./record-store.ts";
import { projReducer, ReducerRegistry } from "./reducers.ts";
import { ProjectError } from "./shared.ts";
import {
  agentOrigin,
  asError,
  createTestProject,
  defined,
  OTHER_SESSION,
  startModules,
  userOrigin,
  type ProjectModules,
} from "./testing/support.ts";
import type {
  AssetId,
  ProjectId,
  ProjectRecord,
  RecordId,
  RecordOrigin,
  RunRequest,
} from "./types.ts";

/** A placeholder that a test replaces once the real function exists. */
const noop = (): void => undefined;

/** @returns a promise with its resolve function, for holding an execute until the test releases it. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * An operation spec with test defaults: a required `name` parameter, an optional `reference` input, and an execute
 * that creates nothing.
 * @param overrides - the fields to set; `name` and `component` are required.
 * @returns the spec.
 */
function operation(
  overrides: Partial<OperationSpec> & Pick<OperationSpec, "name" | "component">,
): OperationSpec {
  return {
    version: "1",
    description: "A test operation.",
    params: { name: { type: "string", required: true } },
    inputs: { reference: { type: "image", description: "A reference." } },
    outputs: [],
    deterministic: false,
    resource: "none",
    summarize: (record) => `deleted ${String(record.params["name"])}`,
    execute: () => Promise.resolve({ outputs: [] }),
    ...overrides,
  };
}

/** The modules, a project, the proposal decider, and an `asset.delete` operation whose `agent` is `propose`. */
interface Fixture {
  m: ProjectModules;
  project: ProjectId;
  decider: ProposalDecider;
  /** The asset the project holds. */
  asset: AssetId;
}

/**
 * @param spec - fields of the `asset.delete` operation to change.
 * @returns the fixture.
 */
async function start(spec: Partial<OperationSpec> = {}): Promise<Fixture> {
  const m = startModules();
  const project = await createTestProject(m);
  m.runner.registerOperation(
    operation({ name: "asset.delete", component: "asset", agent: "propose", ...spec }),
  );
  const decider = new ProposalDecider({ store: m.store, reducers: m.reducers, runner: m.runner });
  return { m, project, decider, asset: m.assets.add("knife.png") };
}

/**
 * A run request of `asset.delete` as the agent of the main test session.
 * @param fixture - the fixture.
 * @param extra - other request fields.
 * @returns the request.
 */
function proposal(fixture: Fixture, extra: Partial<RunRequest> = {}): RunRequest {
  return {
    ...agentOrigin("turn-1", { intent: "the user asked to delete the knife" }),
    project: fixture.project,
    operation: "asset.delete",
    params: { name: "knife" },
    inputs: [{ role: "reference", ref: { asset: fixture.asset } }],
    ...extra,
  };
}

/** @returns the project's records of the operation, in write order. */
function recordsOf(fixture: Fixture, name: string): ProjectRecord[] {
  return fixture.m.store.listRecords(fixture.project).filter((record) => record.operation === name);
}

/** @returns the text of the project's `records.jsonl`. */
function file(fixture: Fixture): string {
  return readFileSync(
    join(fixture.m.root, fixture.project, ".comfy-studio", "records.jsonl"),
    "utf8",
  );
}

/** The user who decides in the app. */
const DECIDER: RecordOrigin = userOrigin({ intent: "accept in the app" });

describe("agent calls", () => {
  it("refuses an agent's run of a propose or none operation before writing, and runs it for the user", async () => {
    const fixture = await start();
    const { m } = fixture;
    m.runner.registerOperation(
      operation({ name: "asset.keep", component: "asset", agent: "none", inputs: {} }),
    );
    const before = file(fixture);
    for (const name of ["asset.delete", "asset.keep"]) {
      const request = { ...proposal(fixture), operation: name, inputs: [] };
      const error = asError(await m.runner.run(request).catch((e: unknown) => e), ProjectError);
      expect(error.code).toBe("agent_not_allowed");
      expect((await m.runner.check(request)).problems).toEqual([error.message]);
    }
    expect(file(fixture)).toBe(before);
    // The same calls from the user's views run.
    const run = await m.runner.run({ ...proposal(fixture), ...userOrigin() });
    expect(run.record?.status).toBe("done");
    // The default is `run`: an agent runs an operation that declares nothing.
    m.runner.registerOperation(operation({ name: "asset.tag", component: "asset", inputs: {} }));
    const tagged = await m.runner.run({ ...proposal(fixture), operation: "asset.tag", inputs: [] });
    expect(tagged.record?.actor).toBe("agent");
  });

  it("refuses to register a read whose agent call proposes", () => {
    const m = startModules();
    expect(() =>
      m.runner.registerOperation(
        operation({ name: "asset.peek", component: "asset", readOnly: true, agent: "propose" }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_params" }));
    // A read without agent calls is fine.
    m.runner.registerOperation(
      operation({ name: "asset.look", component: "asset", readOnly: true, agent: "none" }),
    );
  });
});

describe("propose", () => {
  it("writes a proposal record outside the history and changes nothing else", async () => {
    const fixture = await start();
    const { m, project } = fixture;
    const line = m.store.line(project);
    const events = m.events.length;
    const record = await m.runner.propose(
      proposal(fixture, {
        based_on: brandString<RecordId>("r-base"),
        supersedes: [brandString<RecordId>("r-old")],
      }),
    );
    expect(record).toMatchObject({
      component: "proj",
      operation: PROPOSE_OPERATION,
      operation_version: "1",
      actor: "agent",
      surface: "chat",
      session: "session-a",
      turn: "turn-1",
      tool_call: "call-turn-1",
      intent: "the user asked to delete the knife",
      params: {
        operation: "asset.delete",
        operation_version: "1",
        params: { name: "knife" },
        inputs: [{ role: "reference", ref: { asset: fixture.asset } }],
        based_on: "r-base",
        supersedes: ["r-old"],
      },
      inputs: [],
      outputs: [],
      based_on: null,
      supersedes: [],
      deterministic: true,
      status: "done",
    });
    expect(m.store.line(project)).toEqual(line);
    expect(m.events.slice(events).map(({ event }) => event.kind)).toEqual(["record"]);
    expect(recordsOf(fixture, "asset.delete")).toEqual([]);
    const state = m.reducers.getState(project);
    expect(state.components.proj.records.map((entry) => entry.operation)).toEqual(["proj.create"]);
    expect(state.components.proj.proposals).toEqual({
      [record.id]: {
        id: record.id,
        operation: "asset.delete",
        operation_version: "1",
        params: { name: "knife" },
        inputs: [{ role: "reference", ref: { asset: fixture.asset } }],
        based_on: "r-base",
        supersedes: ["r-old"],
        intent: "the user asked to delete the knife",
        session: "session-a",
        turn: "turn-1",
        tool_call: "call-turn-1",
        created_at: record.created_at,
        status: "pending",
      },
    });
  });

  it("refuses a call that run would refuse, writing nothing", async () => {
    const fixture = await start({
      precondition: (request) =>
        request.params["name"] === "gone"
          ? Promise.reject(new Error("There is no asset gone to delete."))
          : Promise.resolve(),
    });
    const { m } = fixture;
    m.runner.registerOperation(
      operation({ name: "asset.peek", component: "asset", readOnly: true }),
    );
    const before = file(fixture);
    const refusals: Array<[Partial<RunRequest>, string]> = [
      [{ params: {} }, "invalid_params"],
      [
        { inputs: [{ role: "reference", ref: { asset: brandString<AssetId>("missing") } }] },
        "unknown_asset",
      ],
      [{ inputs: [{ role: "style", ref: { asset: fixture.asset } }] }, "invalid_inputs"],
      [{ operation: "asset.nothing" }, "unknown_operation"],
      [{ operation: "asset.peek" }, "invalid_params"],
    ];
    for (const [extra, code] of refusals) {
      const error = asError(
        await m.runner.propose(proposal(fixture, extra)).catch((e: unknown) => e),
        ProjectError,
      );
      expect(error.code).toBe(code);
    }
    await expect(m.runner.propose(proposal(fixture, { params: { name: "gone" } }))).rejects.toThrow(
      "There is no asset gone to delete.",
    );
    expect(file(fixture)).toBe(before);
  });

  it("returns the pending proposal of the same session, operation, params and inputs instead of writing another", async () => {
    const fixture = await start();
    const { m, project } = fixture;
    const first = await m.runner.propose(proposal(fixture));
    // The same call again, with another reason and from another tool call, folds into the first.
    const again = await m.runner.propose(
      proposal(fixture, { intent: "once more", tool_call: "call-2" }),
    );
    expect(again).toEqual(first);
    // Another session, other params or other inputs make a new proposal.
    const other = await m.runner.propose(
      proposal(fixture, agentOrigin("turn-1", { session: OTHER_SESSION })),
    );
    const otherName = await m.runner.propose(proposal(fixture, { params: { name: "fork" } }));
    const noInput = await m.runner.propose(proposal(fixture, { inputs: [] }));
    expect(new Set([first.id, other.id, otherName.id, noInput.id]).size).toBe(4);
    // So does naming a record the accepted call would build on: accepting it is not the same call.
    const [created] = m.store.listRecords(project);
    const based = await m.runner.propose(proposal(fixture, { based_on: defined(created).id }));
    expect(based.id).not.toBe(first.id);
    expect(await m.runner.propose(proposal(fixture, { based_on: defined(created).id }))).toEqual(
      based,
    );
    // Once the first is decided, the same call is a new proposal.
    await fixture.decider.decide(project, first.id, "reject", DECIDER);
    const after = await m.runner.propose(proposal(fixture));
    expect(after.id).not.toBe(first.id);
    expect(recordsOf(fixture, PROPOSE_OPERATION)).toHaveLength(6);
  });

  it("keeps proposals and their decisions across undo, redo, a later step and a reload", async () => {
    const fixture = await start();
    const { m, project } = fixture;
    m.runner.registerOperation(operation({ name: "asset.tag", component: "asset", inputs: {} }));
    const step = await m.runner.run({
      ...proposal(fixture),
      ...userOrigin(),
      operation: "asset.tag",
      inputs: [],
    });
    const pending = await m.runner.propose(proposal(fixture));
    const rejected = await m.runner.propose(proposal(fixture, { params: { name: "fork" } }));
    await fixture.decider.decide(project, rejected.id, "reject", DECIDER);
    const wanted = m.reducers.getState(project).components.proj.proposals;
    expect(Object.values(wanted).map((entry) => entry.status)).toEqual(["pending", "rejected"]);

    await m.store.lock(project, () => m.history.undo(project));
    expect(m.reducers.getState(project).components.proj.proposals).toEqual(wanted);
    // A step after the undo discards the tagged step but no proposal.
    await m.runner.run({
      ...proposal(fixture),
      ...userOrigin(),
      operation: "asset.tag",
      inputs: [],
      params: { name: "b" },
    });
    expect(m.reducers.getState(project).components.proj.proposals).toEqual(wanted);
    expect(m.history.list({ project }).map((entry) => entry.record.id)).not.toContain(
      step.record?.id,
    );
    expect(m.history.list({ project }).map((entry) => entry.record.operation)).toEqual([
      "asset.tag",
      "proj.create",
    ]);

    // A second store over the same folders reads the same proposals back.
    const store = new RecordStore(m.folders, noop);
    const reducers = new ReducerRegistry(store, (record) => m.runner.isOutsideHistory(record));
    reducers.register("proj", projReducer);
    expect(reducers.getState(project).components.proj.proposals).toEqual(wanted);
    expect(defined(wanted[pending.id]).status).toBe("pending");
  });
});

describe("decideProposal", () => {
  it("accepts a proposal by running its call as the user, and records the decision with the record it wrote", async () => {
    const fixture = await start();
    const { m, project } = fixture;
    const proposed = await m.runner.propose(
      proposal(fixture, { supersedes: [brandString<RecordId>("r-old")] }),
    );
    const { proposal: decided, result } = await fixture.decider.decide(
      project,
      proposed.id,
      "accept",
      DECIDER,
    );
    const ran = defined(result?.record);
    expect(ran).toMatchObject({
      operation: "asset.delete",
      actor: "user",
      surface: "view",
      session: "session-a",
      intent: "accept proposal: the user asked to delete the knife",
      params: { name: "knife" },
      supersedes: ["r-old"],
      status: "done",
    });
    expect(m.store.line(project)?.at).toBe(ran.id);
    const [decision] = recordsOf(fixture, DECIDE_OPERATION);
    expect(decision).toMatchObject({
      component: "proj",
      actor: "user",
      intent: "accept in the app",
      params: { proposal: proposed.id, decision: "accepted", record: ran.id },
      status: "done",
    });
    expect(decided).toMatchObject({
      id: proposed.id,
      status: "accepted",
      decided_at: decision?.created_at,
      record: ran.id,
    });
    // The decision is no step: the current position stays at the run's record.
    expect(m.store.line(project)?.at).toBe(ran.id);
  });

  it("rejects a proposal without running anything", async () => {
    const fixture = await start();
    const { m, project } = fixture;
    const proposed = await m.runner.propose(proposal(fixture));
    const outcome = await fixture.decider.decide(project, proposed.id, "reject", {
      ...DECIDER,
      intent: "reject in the app",
    });
    expect(outcome.result).toBeNull();
    expect(outcome.proposal).toMatchObject({ status: "rejected" });
    expect(outcome.proposal).not.toHaveProperty("record");
    expect(recordsOf(fixture, "asset.delete")).toEqual([]);
    expect(recordsOf(fixture, DECIDE_OPERATION).map((record) => record.params)).toEqual([
      { proposal: proposed.id, decision: "rejected" },
    ]);
  });

  it("answers a proposal decided already as it stands and writes nothing", async () => {
    const fixture = await start();
    const { m, project } = fixture;
    const proposed = await m.runner.propose(proposal(fixture));
    const first = await fixture.decider.decide(project, proposed.id, "accept", DECIDER);
    const before = file(fixture);
    for (const decision of ["accept", "reject"] as const) {
      const again = await fixture.decider.decide(project, proposed.id, decision, DECIDER);
      expect(again).toEqual({ proposal: first.proposal, result: null });
    }
    expect(file(fixture)).toBe(before);
    expect(recordsOf(fixture, "asset.delete")).toHaveLength(1);
  });

  it("refuses a second decision while the first is in flight, and runs the call once", async () => {
    const held = gate();
    let runs = 0;
    const fixture = await start({
      execute: async () => {
        runs += 1;
        await held.promise;
        return { outputs: [] };
      },
    });
    const { m, project } = fixture;
    const proposed = await m.runner.propose(proposal(fixture));
    const first = fixture.decider.decide(project, proposed.id, "accept", DECIDER);
    for (const decision of ["accept", "reject"] as const) {
      const error = asError(
        await fixture.decider
          .decide(project, proposed.id, decision, DECIDER)
          .catch((e: unknown) => e),
        ProjectError,
      );
      expect(error.code).toBe("proposal_busy");
    }
    held.resolve();
    expect((await first).proposal.status).toBe("accepted");
    expect(runs).toBe(1);
    expect(recordsOf(fixture, DECIDE_OPERATION)).toHaveLength(1);
    // The mark is gone with the decision: a later call answers the decided proposal.
    expect(
      (await fixture.decider.decide(project, proposed.id, "reject", DECIDER)).result,
    ).toBeNull();
  });

  it("leaves the proposal pending when the run refuses before its record, and records a run that failed", async () => {
    let gone = false;
    const fixture = await start({
      precondition: () =>
        gone ? Promise.reject(new Error("The knife is gone already.")) : Promise.resolve(),
      execute: () => Promise.reject(new Error("The disk is full.")),
    });
    const { m, project } = fixture;
    const proposed = await m.runner.propose(proposal(fixture));
    gone = true;
    const before = file(fixture);
    await expect(fixture.decider.decide(project, proposed.id, "accept", DECIDER)).rejects.toThrow(
      "The knife is gone already.",
    );
    expect(file(fixture)).toBe(before);
    expect(
      defined(m.reducers.getState(project).components.proj.proposals[proposed.id]).status,
    ).toBe("pending");
    // The user may still close it with a rejection; here the state changes back and the accepted run fails.
    gone = false;
    const outcome = await fixture.decider.decide(project, proposed.id, "accept", DECIDER);
    expect(outcome.result?.record?.status).toBe("failed");
    expect(outcome.proposal).toMatchObject({
      status: "accepted",
      record: outcome.result?.record?.id,
    });
  });

  it("refuses an unknown ID, a record that is no proposal, an agent's decision and an unknown project", async () => {
    const fixture = await start();
    const { m, project } = fixture;
    const proposed = await m.runner.propose(proposal(fixture));
    const create = defined(m.store.listRecords(project)[0]);
    const cases: Array<[ProjectId, RecordId, RecordOrigin, string]> = [
      [project, brandString<RecordId>("nope"), DECIDER, "unknown_record"],
      [project, create.id, DECIDER, "unknown_record"],
      [project, proposed.id, agentOrigin(), "agent_not_allowed"],
      [brandString<ProjectId>("elsewhere"), proposed.id, DECIDER, "unknown_project"],
    ];
    const before = file(fixture);
    for (const [where, id, origin, code] of cases) {
      const error = asError(
        await fixture.decider.decide(where, id, "accept", origin).catch((e: unknown) => e),
        ProjectError,
      );
      expect(error.code).toBe(code);
    }
    expect(file(fixture)).toBe(before);
  });

  it("answers the acceptance of a background operation with its pending record, before the run ends", async () => {
    const held = gate();
    let runs = 0;
    const fixture = await start({
      background: true,
      resource: "gpu",
      execute: async () => {
        runs += 1;
        await held.promise;
        return { outputs: [] };
      },
    });
    const { m, project } = fixture;
    const proposed = await m.runner.propose(proposal(fixture));
    const outcome = await fixture.decider.decide(project, proposed.id, "accept", DECIDER);
    const ran = defined(outcome.result?.record);
    expect(ran).toMatchObject({ operation: "asset.delete", actor: "user", status: "pending" });
    expect(outcome.proposal).toMatchObject({ status: "accepted", record: ran.id });
    expect(recordsOf(fixture, DECIDE_OPERATION).map((record) => record.params)).toEqual([
      { proposal: proposed.id, decision: "accepted", record: ran.id },
    ]);
    await vi.waitFor(() => {
      expect(runs).toBe(1);
    });
    expect(m.store.getRecord(project, ran.id).status).toBe("running");
    held.resolve();
    await m.scheduler.wait(project, [ran.id]);
    expect(m.store.getRecord(project, ran.id).status).toBe("done");
    expect(runs).toBe(1);
    expect(recordsOf(fixture, "asset.delete")).toHaveLength(1);
    expect(recordsOf(fixture, DECIDE_OPERATION)).toHaveLength(1);
  });

  it("schedules an accepted call whose input names a record output that has not finished", async () => {
    const held = gate();
    const fixture = await start();
    const { m, project } = fixture;
    m.runner.registerOperation(
      operation({
        name: "image.make",
        component: "image",
        inputs: {},
        params: {},
        outputs: [{ role: "still", type: "image" }],
        execute: async (context) => {
          await held.promise;
          return {
            outputs: [
              context.importAsset(Buffer.from("made"), { mime: "image/png", name: "m.png" }),
            ],
          };
        },
      }),
    );
    const made = await m.runner.run({
      ...userOrigin(),
      project,
      operation: "image.make",
      params: {},
      inputs: [],
      after: [],
    });
    const producer = defined(made.record);
    const proposed = await m.runner.propose(
      proposal(fixture, {
        inputs: [{ role: "reference", ref: { record: producer.id, output: 0 } }],
        after: [],
      }),
    );
    const outcome = await fixture.decider.decide(project, proposed.id, "accept", DECIDER);
    const ran = defined(outcome.result?.record);
    expect(ran.status).toBe("pending");
    expect(outcome.proposal.record).toBe(ran.id);
    held.resolve();
    await m.scheduler.wait(project, [ran.id]);
    expect(m.store.getRecord(project, ran.id).status).toBe("done");
  });
});
