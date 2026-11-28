/**
 * The operation runner: the operation registry and the single change path of operations. `run` checks a request,
 * writes its pending record after the project's current position, then executes the operation now or hands the record to the
 * scheduler.
 *
 * Lock scope: the runner holds the project lock (from the record store) while it checks and appends a record and
 * while it writes each update line. It releases the lock while `execute` runs, so a long generation does not block other
 * edits, and an operation's `execute` may itself call `csProject.run`.
 *
 * Calls: the record store (lock, head, append, update, records), the reducer
 * registry (state at a record's parent, the reference assets of a version), the scheduler (`enqueue`), and the
 * asset store. Called by the service and by the scheduler (`execute`).
 *
 * @module @cs/project/runner
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArgs } from "@deepseek-ai/dsh-tools";
import { discardedSteps } from "./history.ts";
import type { OperationSpec } from "./operation-types.ts";
import type { ReducerRegistry } from "./reducers.ts";
import type { RecordLineInput, RecordStore } from "./record-store.ts";
import { isProposalRecord, PROPOSE_OPERATION } from "./proposals.ts";
import type { Scheduler } from "./scheduler.ts";
import { OperationFailure, ProjectError } from "./shared.ts";
import type {
  AssetId,
  OperationCheck,
  OperationContext,
  ProjectId,
  ProjectRecord,
  ProjectState,
  RecordFailure,
  RecordId,
  RecordInput,
  RecordOrigin,
  RecordUpdate,
  RunRequest,
  RunResult,
} from "./types.ts";

/** What the runner needs from the asset store. */
export interface RunnerAssets {
  /**
   * @param asset - an asset ID.
   * @returns whether the asset store holds it.
   */
  has(asset: AssetId): boolean;
  /**
   * Import a file or bytes into the asset store, in the project's folder.
   * @param project - the project whose folder receives the bytes.
   * @param source - the bytes, or a file path to copy.
   * @param meta - the media type, the display name, the duration for audio and video, and the pixel size when known.
   * @param createdBy - the record that created the asset; null for a read-only operation.
   * @returns the asset's ID.
   */
  importAsset(
    project: ProjectId,
    source: Parameters<OperationContext["importAsset"]>[0],
    meta: Parameters<OperationContext["importAsset"]>[1],
    createdBy: RecordId | null,
  ): AssetId;
}

/** The failure of a record whose step a later write discarded before it finished. */
const DISCARDED: RecordFailure = {
  code: "discarded",
  message: "A new step after an undo discarded this step before it finished.",
};

/** The modules and services the runner calls. */
export interface RunnerDeps {
  store: RecordStore;
  reducers: ReducerRegistry;
  assets: RunnerAssets;
  scheduler: Scheduler;
}

/**
 * JSON with object keys sorted at every level, so that two equal params objects give the same text.
 * @param value - a JSON value.
 * @returns its canonical text.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The `resolved_asset` values of a record's inputs by role, as one text, for comparing two calls. The roles are in
 * sorted order, so the order in which a call names its roles does not matter; the assets of one role keep the order
 * the call gave them. Two calls that give the same assets to different roles, or to one role in another order, are
 * different calls: an operation's inputs are not interchangeable.
 * @param inputs - the record's inputs.
 * @returns the canonical text.
 */
function resolvedAssetsKey(inputs: RecordInput[]): string {
  const byRole: Record<string, string[]> = {};
  for (const input of inputs) (byRole[input.role] ??= []).push(String(input.resolved_asset));
  return canonicalJson(byRole);
}

/**
 * @param error - what a call threw.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The six origin fields a record copies from a run request.
 * @param request - the run request.
 * @returns the origin.
 */
function originOf(request: RunRequest): RecordOrigin {
  return {
    actor: request.actor,
    surface: request.surface,
    session: request.session,
    turn: request.turn,
    tool_call: request.tool_call,
    intent: request.intent,
  };
}

/**
 * Refuse an agent's request for an operation whose `agent` is `propose` or `none`, before anything is read or written;
 * the agent tools never send one, and this keeps the rule for every other caller too.
 * @param spec - the operation.
 * @param request - the call.
 */
function refuseAgent(spec: OperationSpec, request: RunRequest): void {
  const agent = spec.agent ?? "run";
  if (request.actor !== "agent" || agent === "run") return;
  throw new ProjectError(
    "agent_not_allowed",
    agent === "propose"
      ? `An agent cannot run ${spec.name}; it proposes the call and the user decides.`
      : `An agent cannot call ${spec.name}; only the user runs it.`,
  );
}

/** The operation registry and the change path. */
export class Runner {
  private readonly operations = new Map<string, OperationSpec>();
  private readonly components = new Set<string>();
  /** The abort controller of every executing record, so a write that discards the record's step can stop it. */
  private readonly executing = new Map<RecordId, AbortController>();
  /** Records a write discarded before they started executing; `execute` ends them at once. */
  private readonly discarded = new Set<RecordId>();

  private readonly deps: RunnerDeps;

  /**
   * @param deps - the modules and services the runner calls.
   */
  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  /**
   * Register a component key, which a plugin's operations then name in `component`. Refused with `component_exists`
   * when the key is registered.
   * @param key - the component key, such as `asset`.
   * @returns a function that removes the key (only if it is still registered).
   */
  registerComponent(key: string): () => void {
    if (this.components.has(key))
      throw new ProjectError("component_exists", `Component ${key} is already registered.`);
    this.components.add(key);
    return () => {
      this.components.delete(key);
    };
  }

  /** @returns whether the component key is registered. */
  hasComponent(key: string): boolean {
    return this.components.has(key);
  }

  /**
   * Register an operation. Refused with `operation_exists` when the name is registered, and with `invalid_params` when
   * `component` is not a registered component key, when `name` does not start with `<component>.`, or when a
   * `readOnly` operation has `agent: 'propose'` (a read changes nothing to propose).
   * @param spec - the operation.
   * @returns a function that removes the registration (only if it is still this spec).
   */
  registerOperation(spec: OperationSpec): () => void {
    if (this.operations.has(spec.name))
      throw new ProjectError("operation_exists", `Operation ${spec.name} is already registered.`);
    if (!this.components.has(spec.component)) {
      throw new ProjectError(
        "invalid_params",
        `Operation ${spec.name} names the component '${spec.component}', which no plugin registered.`,
      );
    }
    if (!spec.name.startsWith(`${spec.component}.`)) {
      throw new ProjectError(
        "invalid_params",
        `Operation ${spec.name} does not start with its component key '${spec.component}.'.`,
      );
    }
    if (spec.readOnly === true && spec.agent === "propose") {
      throw new ProjectError(
        "invalid_params",
        `Operation ${spec.name} is a read, so an agent's call has nothing to propose.`,
      );
    }
    this.operations.set(spec.name, spec);
    return () => {
      if (this.operations.get(spec.name) === spec) this.operations.delete(spec.name);
    };
  }

  /** @returns every registered operation, in registration order. */
  listOperations(): OperationSpec[] {
    return [...this.operations.values()];
  }

  /**
   * @param record - a record.
   * @returns whether the record is written outside the history: its operation is registered with `outsideHistory`,
   *   or it is a proposal record (`proj.propose`, `proj.proposal_decide`).
   */
  isOutsideHistory(record: ProjectRecord): boolean {
    if (isProposalRecord(record)) return true;
    return (
      record.operation !== null && this.operations.get(record.operation)?.outsideHistory === true
    );
  }

  /**
   * Run one operation call. The steps are listed in `CONTRACTS.md` ("Runner: run"). Rejects with `ProjectError` only
   * before a record exists (unknown operation, an agent's call of a `propose` or `none` operation, invalid params or
   * inputs, input not ready, unknown project), or with the error of the operation's `precondition`. Once the record
   * is written, resolves with it in its final status (`done`, `failed`, `cancelled`), or `pending` for a scheduled run.
   * @param request - the call.
   * @returns the record, its outputs and report.
   */
  async run(request: RunRequest): Promise<RunResult> {
    const { store, reducers, scheduler } = this.deps;
    const spec = this.operations.get(request.operation);
    if (spec === undefined)
      throw new ProjectError(
        "unknown_operation",
        `Operation ${request.operation} is not registered.`,
      );
    refuseAgent(spec, request);
    store.getProject(request.project);

    if (spec.readOnly === true) return await this.runRead(spec, request);

    const pending = await store.lock(request.project, async () => {
      // The call is refused before the append, so that a refused call writes nothing; the state at the head is the
      // state at the new record's parent, and the lock keeps it current.
      const state = reducers.getState(request.project);
      const inputs = await this.refuse(spec, request, state, request.after !== undefined);
      // The operation names the records it replaces itself; the caller may name more.
      const supersedes = [
        ...new Set([
          ...(request.supersedes ?? []),
          ...(spec.supersedes?.(request.params, state) ?? []),
        ]),
      ];
      const origin = originOf(request);
      const line: RecordLineInput = {
        parents: [this.headOf(request.project)],
        kind: "operation",
        component: spec.component,
        operation: spec.name,
        operation_version: spec.version,
        ...origin,
        params: request.params,
        inputs,
        outputs: [],
        based_on: request.based_on ?? spec.basedOn?.(request.params, state) ?? null,
        supersedes,
        deterministic: spec.deterministic,
        status: "pending",
        ...(request.started_by === undefined ? {} : { started_by: request.started_by }),
      };
      return spec.outsideHistory === true
        ? store.appendOutsideHistory(request.project, line)
        : this.appendStep(request.project, line);
    });

    if (request.after !== undefined) {
      scheduler.enqueue(
        request.project,
        pending.id,
        spec.resource,
        request.after,
        spec.pendingInputRoles ?? [],
      );
      return { record: pending, outputs: [], report: null };
    }
    const final = await this.execute(request.project, pending.id, request.signal);
    return { record: final, outputs: final.outputs, report: final.report ?? null };
  }

  /**
   * Execute a pending record: reuse the outputs of an identical deterministic record, or update it to `running`, call
   * the operation's `execute`, and write the final update. Used by `run` and by the scheduler. Never rejects for the
   * operation's own failure.
   * @param project - the project.
   * @param record - a `pending` record.
   * @param signal - the run request's signal; scheduled records run without one.
   * @returns the record in its final status.
   */
  async execute(
    project: ProjectId,
    record: RecordId,
    signal?: AbortSignal,
  ): Promise<ProjectRecord> {
    const { store, reducers, assets } = this.deps;
    if (this.discarded.delete(record))
      return await this.finish(project, record, "cancelled", DISCARDED);
    const pending = store.getRecord(project, record);
    const spec = pending.operation === null ? undefined : this.operations.get(pending.operation);
    if (spec === undefined) {
      return await this.finish(project, record, "failed", {
        code: "operation_failed",
        message: `Operation ${String(pending.operation)} is not registered.`,
      });
    }
    // A pending input role may name a generation that is still running or failed: the operation handles the null asset.
    const pendingRoles = new Set(spec.pendingInputRoles ?? []);
    const unresolved = pending.inputs.find(
      (input) => input.resolved_asset === null && !pendingRoles.has(input.role),
    );
    if (unresolved !== undefined) {
      return await this.finish(project, record, "failed", {
        code: "input_failed",
        message: `Input '${unresolved.role}' has no asset: the record it names did not finish done.`,
      });
    }
    const reused = spec.deterministic ? this.reusableOutputs(project, pending) : null;
    if (reused !== null) {
      return await this.update(project, {
        update: record,
        status: "done",
        finished_at: new Date().toISOString(),
        outputs: reused,
        cost: { wall_seconds: 0, reused: true },
      });
    }

    // The run request's signal stops the call ('stopped'); a write that discards the step aborts it too ('discarded').
    const controller = new AbortController();
    const stop = (): void => {
      controller.abort("stopped");
    };
    if (signal?.aborted === true) stop();
    signal?.addEventListener("abort", stop, { once: true });
    this.executing.set(record, controller);
    const running = await this.update(project, {
      update: record,
      status: "running",
      started_at: new Date().toISOString(),
    });
    let scratchDir: string | null = null;
    try {
      // `parents[0]` always exists: an operation record follows at least the project's `proj.create` record.
      const state = reducers.stateAt(project, running.parents[0] ?? running.id);
      scratchDir = await mkdtemp(join(tmpdir(), "cs-operation-"));
      const started = performance.now();
      const result = await spec.execute({
        project,
        record: running,
        params: running.params,
        inputs: running.inputs,
        state,
        scratchDir,
        signal: controller.signal,
        importAsset: (source, meta) => assets.importAsset(project, source, meta, record),
      });
      const wallSeconds = Math.round(performance.now() - started) / 1000;
      return await this.update(project, {
        update: record,
        status: "done",
        finished_at: new Date().toISOString(),
        outputs: result.outputs,
        cost: { wall_seconds: wallSeconds, reused: false },
        ...(result.report === undefined ? {} : { report: result.report }),
      });
    } catch (error: unknown) {
      if (controller.signal.reason === "discarded")
        return await this.finish(project, record, "cancelled", DISCARDED);
      if (controller.signal.aborted) {
        return await this.finish(project, record, "cancelled", {
          code: "stopped",
          message: `The turn was stopped while ${spec.name} ran: ${messageOf(error)}`,
        });
      }
      return await this.finish(project, record, "failed", {
        code: error instanceof OperationFailure ? error.code : "operation_failed",
        message: messageOf(error),
      });
    } finally {
      this.executing.delete(record);
      signal?.removeEventListener("abort", stop);
      if (scratchDir !== null) await rm(scratchDir, { recursive: true, force: true });
    }
  }

  /**
   * Propose one call instead of running it: check it as `run` would check it before writing (operation, params, input
   * roles, the records `after` names, inputs, `precondition`) against the current state, then append a `proj.propose`
   * record outside the history. A pending proposal of the same session with the same operation, params and inputs is
   * returned instead of a new one. Takes the project lock.
   * @param request - the call; its origin becomes the proposal record's origin.
   * @returns the `proj.propose` record. Rejects with the refusals of `run`, and with `invalid_params` for a read.
   */
  async propose(request: RunRequest): Promise<ProjectRecord> {
    const { store, reducers } = this.deps;
    const spec = this.operations.get(request.operation);
    if (spec === undefined)
      throw new ProjectError(
        "unknown_operation",
        `Operation ${request.operation} is not registered.`,
      );
    store.getProject(request.project);
    if (spec.readOnly === true) {
      throw new ProjectError(
        "invalid_params",
        `Operation ${spec.name} is a read; it writes nothing, so there is nothing to propose.`,
      );
    }
    return await store.lock(request.project, async () => {
      const state = reducers.getState(request.project);
      await this.refuse(spec, request, state, request.after !== undefined);
      const inputs = request.inputs.map(({ role, ref }) => ({ role, ref }));
      const paramsKey = canonicalJson(request.params);
      const inputsKey = canonicalJson(inputs);
      const same = Object.values(state.components.proj.proposals).find(
        (proposal) =>
          proposal.status === "pending" &&
          proposal.session === request.session &&
          proposal.operation === spec.name &&
          canonicalJson(proposal.params) === paramsKey &&
          canonicalJson(proposal.inputs) === inputsKey,
      );
      if (same !== undefined) return store.getRecord(request.project, same.id);
      return store.appendOutsideHistory(request.project, {
        parents: [this.headOf(request.project)],
        kind: "operation",
        component: "proj",
        operation: PROPOSE_OPERATION,
        operation_version: "1",
        ...originOf(request),
        params: {
          operation: spec.name,
          operation_version: spec.version,
          params: request.params,
          inputs,
          based_on: request.based_on ?? null,
          supersedes: request.supersedes ?? [],
        },
        inputs: [],
        outputs: [],
        based_on: null,
        supersedes: [],
        deterministic: true,
        status: "done",
      });
    });
  }

  /**
   * Accept a stale record's result: append `proj.stale_accept` with `params {record}` after the head. Takes the project
   * lock.
   * @param project - the project.
   * @param record - a record that is stale in the current state.
   * @param origin - who accepts it.
   * @returns the `proj.stale_accept` record.
   */
  acceptStale(project: ProjectId, record: RecordId, origin: RecordOrigin): Promise<ProjectRecord> {
    const { store } = this.deps;
    return store.lock(project, () => {
      store.getRecord(project, record);
      return this.appendStep(project, {
        parents: [this.headOf(project)],
        kind: "operation",
        component: "proj",
        operation: "proj.stale_accept",
        operation_version: "1",
        ...origin,
        params: { record },
        inputs: [],
        outputs: [],
        based_on: null,
        supersedes: [],
        deterministic: true,
        status: "done",
      });
    });
  }

  /**
   * At service start, end the records an earlier process left unfinished: every `pending` or `running` operation
   * record is updated to `cancelled` with `error {code: 'stopped', message}`, so no record stays unfinished forever.
   */
  async recover(): Promise<void> {
    const { store } = this.deps;
    await Promise.all(
      store.listProjects().map((info) =>
        store.lock(info.id, () => {
          for (const record of store.listRecords(info.id)) {
            if (record.status !== "pending" && record.status !== "running") continue;
            store.update(info.id, {
              update: record.id,
              status: "cancelled",
              finished_at: new Date().toISOString(),
              error: { code: "stopped", message: "The server stopped before the call finished." },
            });
          }
        }),
      ),
    );
  }

  /**
   * Check one call against every refusal of {@link run} without writing anything. The check reads the state outside
   * the project lock, so its answer is advisory: `run` checks the call again under the lock.
   * @param request - the call.
   * @returns the refusal sentence, empty when `run` would accept the call on the current state.
   */
  async check(request: RunRequest): Promise<OperationCheck> {
    const spec = this.operations.get(request.operation);
    try {
      if (spec === undefined)
        throw new ProjectError(
          "unknown_operation",
          `Operation ${request.operation} is not registered.`,
        );
      refuseAgent(spec, request);
      this.deps.store.getProject(request.project);
      const state = this.deps.reducers.getState(request.project);
      await this.refuse(
        spec,
        request,
        state,
        request.after !== undefined && spec.readOnly !== true,
      );
      return { problems: [] };
    } catch (error) {
      return { problems: [messageOf(error)] };
    }
  }

  /**
   * The refusals of one call before any record exists, in the order that `run`, `runRead` and `check` share: params and
   * input roles, the records named by `after`, the inputs, and the operation's `precondition`.
   * @param spec - the operation.
   * @param request - the call.
   * @param state - the state the inputs resolve against.
   * @param allowUnfinished - whether an input may name an output of a record that has not finished: true for a call
   *   that waits for its producers (`after`); a read runs at once, so it never waits.
   * @returns the record inputs.
   */
  private async refuse(
    spec: OperationSpec,
    request: RunRequest,
    state: ProjectState,
    allowUnfinished: boolean,
  ): Promise<RecordInput[]> {
    this.checkRequest(spec, request);
    for (const record of request.after ?? []) this.deps.store.getRecord(request.project, record);
    const inputs = this.resolveInputs(spec, request, state, allowUnfinished);
    await spec.precondition?.(request, state);
    return inputs;
  }

  /**
   * Check a request's params against the operation's schema and its input roles against the operation's roles.
   * @param spec - the operation.
   * @param request - the call.
   */
  private checkRequest(spec: OperationSpec, request: RunRequest): void {
    const messages = validateArgs(spec.params, request.params);
    if (messages.length > 0) {
      throw new ProjectError(
        "invalid_params",
        `Invalid parameters for ${spec.name}: ${messages.join("; ")}`,
      );
    }
    const role = request.inputs.find((input) => !Object.hasOwn(spec.inputs, input.role));
    if (role !== undefined) {
      throw new ProjectError(
        "invalid_inputs",
        `Operation ${spec.name} takes no input with role '${role.role}'.`,
      );
    }
  }

  /**
   * Run a read-only operation on the project's current state: no lock and no record.
   * @param spec - a read-only operation.
   * @param request - the call.
   * @returns the outputs and the report; the record is null.
   */
  private async runRead(spec: OperationSpec, request: RunRequest): Promise<RunResult> {
    const { reducers, assets } = this.deps;
    const state = reducers.getState(request.project);
    const inputs = await this.refuse(spec, request, state, false);
    const scratchDir = await mkdtemp(join(tmpdir(), "cs-operation-"));
    try {
      const result = await spec.execute({
        project: request.project,
        record: null,
        params: request.params,
        inputs,
        state,
        scratchDir,
        signal: request.signal ?? new AbortController().signal,
        importAsset: (source, meta) => assets.importAsset(request.project, source, meta, null),
      });
      return { record: null, outputs: result.outputs, report: result.report ?? null };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  /**
   * Turn the request's input refs into record inputs against a state. An asset ref must name a stored asset; a record
   * output ref resolves to the producer's output once the producer is done; a version ref of a registered reference
   * kind becomes one input per asset of that version. A record output ref of one of the operation's `pendingInputRoles`
   * may name a producer in any status: it resolves to null until the producer is done.
   * @param spec - the operation.
   * @param request - the call.
   * @param state - the state the record's inputs resolve against.
   * @param allowUnfinished - whether a pending or running producer is allowed (a scheduled run).
   * @returns the record inputs.
   */
  private resolveInputs(
    spec: OperationSpec,
    request: RunRequest,
    state: ProjectState,
    allowUnfinished: boolean,
  ): RecordInput[] {
    const { store, reducers, assets } = this.deps;
    return request.inputs.flatMap(({ role, ref }): RecordInput[] => {
      if ("asset" in ref) {
        if (!assets.has(ref.asset))
          throw new ProjectError(
            "unknown_asset",
            `Input '${role}' names an unknown asset ${ref.asset}.`,
          );
        return [{ role, ref, resolved_asset: ref.asset }];
      }
      if ("record" in ref) {
        if (!Number.isInteger(ref.output) || ref.output < 0) {
          throw new ProjectError(
            "invalid_inputs",
            `Input '${role}' names output ${String(ref.output)}, which is not an output index.`,
          );
        }
        const producer = store.getRecord(request.project, ref.record);
        if (producer.status === "done") {
          const asset = producer.outputs[ref.output];
          if (asset === undefined) {
            throw new ProjectError(
              "invalid_inputs",
              `Input '${role}': record ${ref.record} has no output ${String(ref.output)}.`,
            );
          }
          return [{ role, ref, resolved_asset: asset }];
        }
        if (spec.pendingInputRoles?.includes(role) === true)
          return [{ role, ref, resolved_asset: null }];
        if (producer.status === "failed" || producer.status === "cancelled") {
          throw new ProjectError(
            "invalid_inputs",
            `Input '${role}': record ${ref.record} ended ${producer.status}.`,
          );
        }
        if (!allowUnfinished) {
          throw new ProjectError(
            "input_not_ready",
            `Input '${role}': record ${ref.record} has not finished; schedule the call with after.`,
          );
        }
        return [{ role, ref, resolved_asset: null }];
      }
      const resolved = reducers.assetsOf(state, ref);
      if (resolved === null)
        throw new ProjectError(
          "invalid_inputs",
          `Input '${role}' names an unknown version: ${JSON.stringify(ref)}.`,
        );
      return resolved.map((asset) => ({ role, ref, resolved_asset: asset }));
    });
  }

  /**
   * The outputs of an earlier executed record with the same operation, version, params and resolved assets by role.
   * @param project - the project.
   * @param record - the pending record.
   * @returns the earlier record's outputs, or null when there is none.
   */
  private reusableOutputs(
    project: ProjectId,
    record: ProjectRecord,
  ): ProjectRecord["outputs"] | null {
    const params = canonicalJson(record.params);
    const assetsKey = resolvedAssetsKey(record.inputs);
    for (const earlier of this.deps.store.listRecords(project)) {
      if (earlier.id === record.id) break;
      if (
        earlier.operation !== record.operation ||
        earlier.operation_version !== record.operation_version
      )
        continue;
      if (earlier.status !== "done" || earlier.cost?.reused === true) continue;
      if (
        canonicalJson(earlier.params) === params &&
        resolvedAssetsKey(earlier.inputs) === assetsKey
      )
        return earlier.outputs;
    }
    return null;
  }

  /**
   * @param project - the project.
   * @returns the project's current position; every project has its `proj.create` record.
   */
  private headOf(project: ProjectId): RecordId {
    return this.deps.store.requireLine(project).at;
  }

  /**
   * Append a step after the current position under the project lock the caller holds. The steps after the current
   * position leave the history list; each of them that has not finished is cancelled: a queued scheduled record leaves
   * the queue and ends `cancelled` at once, an executing record is aborted, and a pending record that has not started
   * ends when it starts. Every such record ends with `error {code: 'discarded'}`.
   * @param project - the project.
   * @param line - the record line.
   * @returns the stored record.
   */
  private appendStep(project: ProjectId, line: RecordLineInput): ProjectRecord {
    const { store, scheduler } = this.deps;
    const dropped = discardedSteps(store, project);
    const appended = store.append(project, line);
    for (const record of dropped) {
      if (record.status !== "pending" && record.status !== "running") continue;
      const controller = this.executing.get(record.id);
      if (controller !== undefined) controller.abort("discarded");
      else if (scheduler.cancel(project, record.id))
        store.update(project, {
          update: record.id,
          status: "cancelled",
          finished_at: new Date().toISOString(),
          error: DISCARDED,
        });
      else this.discarded.add(record.id);
    }
    return appended;
  }

  /**
   * Write an update line under the project lock.
   * @param project - the project.
   * @param update - the update line.
   * @returns the record after the update.
   */
  private update(project: ProjectId, update: RecordUpdate): Promise<ProjectRecord> {
    return this.deps.store.lock(project, () => this.deps.store.update(project, update));
  }

  /**
   * Write a final update that ends a record without outputs.
   * @param project - the project.
   * @param record - the record.
   * @param status - `failed` or `cancelled`.
   * @param error - why.
   * @returns the record after the update.
   */
  private finish(
    project: ProjectId,
    record: RecordId,
    status: "failed" | "cancelled",
    error: RecordFailure,
  ): Promise<ProjectRecord> {
    return this.update(project, {
      update: record,
      status,
      finished_at: new Date().toISOString(),
      error,
    });
  }
}
