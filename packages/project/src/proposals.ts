/**
 * Proposals: an agent's call of an operation whose `agent` is `propose` (or a function that answers `propose` for the
 * project's current state) does not run; the runner writes a
 * `proj.propose` record instead (`Runner.propose`), and the user accepts or rejects it later. Accepting runs the same
 * operation as the user through `Runner.run`; either decision writes one `proj.proposal_decide` record. Both records
 * are written outside the history (`RecordStore.appendOutsideHistory`): they are no step, undo never removes them, and
 * they discard no step. The `proj` reducer folds them into `ComponentStates.proj.proposals` with {@link reduceProposals}.
 *
 * Lock scope: a decision holds the project lock only while it appends its record. The accepted run takes the lock
 * itself; the in-flight mark of {@link ProposalDecider} keeps two decisions of one proposal from both running it.
 *
 * Spec: `docs/archive/PLAN_2-3a.md` and `CONTRACTS.md` ("Proposals").
 *
 * @module @cs/project/proposals
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import { z as zod } from "zod";
import type { ReducerRegistry } from "./reducers.ts";
import type { RecordStore } from "./record-store.ts";
import type { Runner } from "./runner.ts";
import { ProjectError } from "./shared.ts";
import type {
  ProjectId,
  ProjectRecord,
  Proposal,
  RecordId,
  RecordInputRef,
  RecordOrigin,
  RunRequest,
  RunResult,
} from "./types.ts";

/** The operation name of a proposal record. */
export const PROPOSE_OPERATION = "proj.propose";

/** The operation name of the record that decides a proposal. */
export const DECIDE_OPERATION = "proj.proposal_decide";

/** What the user does with a proposal. */
export type ProposalDecision = "accept" | "reject";

/**
 * @param record - a record.
 * @returns whether it is a `proj.propose` or a `proj.proposal_decide` record, both written outside the history.
 */
export function isProposalRecord(record: Pick<ProjectRecord, "component" | "operation">): boolean {
  return (
    record.component === "proj" &&
    (record.operation === PROPOSE_OPERATION || record.operation === DECIDE_OPERATION)
  );
}

const recordId = zod.string().transform((value) => brandString<RecordId>(value));

/** The `params` of a `proj.propose` record. The input refs are stored as the run request gave them. */
const proposeParams = zod.object({
  operation: zod.string(),
  operation_version: zod.string(),
  params: zod.record(zod.string(), zod.unknown()),
  inputs: zod.array(
    zod.object({
      role: zod.string(),
      ref: zod.custom<RecordInputRef>(
        (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      ),
    }),
  ),
  based_on: recordId.nullable(),
  supersedes: zod.array(recordId),
});

/** The `params` of a `proj.proposal_decide` record. */
const decideParams = zod.object({
  proposal: recordId,
  decision: zod.enum(["accepted", "rejected"]),
  record: recordId.optional(),
});

/**
 * Apply one record to the proposals of the `proj` slice. A `proj.propose` record adds a pending proposal; a
 * `proj.proposal_decide` record decides a pending one (a later decision of a decided proposal changes nothing).
 * Every other record, and a proposal record whose params do not parse, returns the same object.
 * @param proposals - the proposals before the record.
 * @param record - the record.
 * @returns the proposals after it.
 */
export function reduceProposals(
  proposals: Record<RecordId, Proposal>,
  record: ProjectRecord,
): Record<RecordId, Proposal> {
  if (record.component !== "proj") return proposals;
  if (record.operation === PROPOSE_OPERATION) {
    const parsed = proposeParams.safeParse(record.params);
    if (!parsed.success) return proposals;
    const proposal: Proposal = {
      id: record.id,
      ...parsed.data,
      intent: record.intent,
      session: record.session,
      turn: record.turn,
      tool_call: record.tool_call,
      created_at: record.created_at,
      status: "pending",
    };
    return { ...proposals, [record.id]: proposal };
  }
  if (record.operation === DECIDE_OPERATION) {
    const parsed = decideParams.safeParse(record.params);
    if (!parsed.success) return proposals;
    const { proposal: id, decision, record: ran } = parsed.data;
    const proposal = proposals[id];
    if (proposal === undefined || proposal.status !== "pending") return proposals;
    const decided: Proposal = {
      ...proposal,
      status: decision,
      decided_at: record.created_at,
      ...(decision === "accepted" && ran !== undefined ? { record: ran } : {}),
    };
    return { ...proposals, [id]: decided };
  }
  return proposals;
}

/** The modules a decision calls. */
export interface ProposalDeps {
  store: RecordStore;
  reducers: ReducerRegistry;
  runner: Runner;
}

/** What {@link ProposalDecider.decide} returns: the proposal after the call, and the accepted run's result. */
export interface ProposalOutcome {
  proposal: Proposal;
  /** The result of the run the acceptance made; null for a rejection or a proposal that was already decided. */
  result: RunResult | null;
}

/** Decides proposals, one decision per proposal at a time. */
export class ProposalDecider {
  /** `<project> <proposal>` of every decision in flight. */
  private readonly busy = new Set<string>();

  private readonly deps: ProposalDeps;

  /**
   * @param deps - the record store, the reducer registry and the runner.
   */
  constructor(deps: ProposalDeps) {
    this.deps = deps;
  }

  /**
   * Accept or reject a proposal; the rules are in `CONTRACTS.md` ("Proposals").
   * @param project - the project.
   * @param id - the `proj.propose` record.
   * @param decision - `accept` runs the proposed call as `origin`; `reject` only records the decision.
   * @param origin - who decides, from where; an agent cannot decide.
   * @returns the proposal after the call and the accepted run's result; for a scheduled run (an input behind an
   *   unfinished record, or a `background` operation) the result holds the `pending` record and the decision is
   *   written without waiting for the execution. Throws `unknown_project`, `unknown_record`
   *   for an ID that names no proposal, `agent_not_allowed` for an agent's decision, `proposal_busy` while another
   *   decision of the proposal is in flight, or the refusal of the accepted run (the proposal stays pending).
   */
  async decide(
    project: ProjectId,
    id: RecordId,
    decision: ProposalDecision,
    origin: RecordOrigin,
  ): Promise<ProposalOutcome> {
    const { store } = this.deps;
    store.getProject(project);
    if (origin.actor === "agent") {
      throw new ProjectError(
        "agent_not_allowed",
        `Only the user decides proposal ${id}; an agent proposes and waits.`,
      );
    }
    const record = store.getRecord(project, id);
    if (record.component !== "proj" || record.operation !== PROPOSE_OPERATION)
      throw new ProjectError("unknown_record", `Record ${id} is not a proposal.`);
    const key = `${project} ${id}`;
    if (this.busy.has(key)) {
      throw new ProjectError(
        "proposal_busy",
        `Proposal ${id} is being decided already; try again when that decision is done.`,
      );
    }
    this.busy.add(key);
    try {
      const proposal = this.proposalOf(project, id);
      if (proposal.status !== "pending") return { proposal, result: null };
      if (decision === "reject") {
        await this.writeDecision(project, origin, { proposal: id, decision: "rejected" });
        return { proposal: this.proposalOf(project, id), result: null };
      }
      // A refusal before the run's record exists rejects here, and the proposal stays pending.
      const result = await this.deps.runner.run(this.acceptRequest(project, proposal, origin));
      await this.writeDecision(project, origin, {
        proposal: id,
        decision: "accepted",
        ...(result.record === null ? {} : { record: result.record.id }),
      });
      return { proposal: this.proposalOf(project, id), result };
    } finally {
      this.busy.delete(key);
    }
  }

  /**
   * @param project - the project.
   * @param id - a `proj.propose` record.
   * @returns the proposal in the current state; `unknown_record` when the record's params name no proposal.
   */
  private proposalOf(project: ProjectId, id: RecordId): Proposal {
    const proposal = this.deps.reducers.getState(project).components.proj.proposals[id];
    if (proposal === undefined)
      throw new ProjectError("unknown_record", `Record ${id} is not a readable proposal.`);
    return proposal;
  }

  /**
   * The run request of an accepted proposal: the proposed operation, params, inputs, `based_on` and `supersedes`,
   * as the deciding user, scheduled (`after: []`) when an input names a record output that has not finished.
   * @param project - the project.
   * @param proposal - the pending proposal.
   * @param origin - who accepts it.
   * @returns the request.
   */
  private acceptRequest(project: ProjectId, proposal: Proposal, origin: RecordOrigin): RunRequest {
    const spec = this.deps.runner
      .listOperations()
      .find((candidate) => candidate.name === proposal.operation);
    const pendingRoles = new Set(spec?.pendingInputRoles ?? []);
    const waits = proposal.inputs.some((input) => {
      if (!("record" in input.ref) || pendingRoles.has(input.role)) return false;
      try {
        return this.deps.store.getRecord(project, input.ref.record).status !== "done";
      } catch {
        // An unknown record is refused by the run itself, with its own message.
        return false;
      }
    });
    return {
      ...origin,
      intent: `accept proposal: ${proposal.intent}`,
      project,
      operation: proposal.operation,
      params: proposal.params,
      inputs: proposal.inputs,
      based_on: proposal.based_on,
      supersedes: proposal.supersedes,
      ...(waits ? { after: [] } : {}),
    };
  }

  /**
   * Append the `proj.proposal_decide` record outside the history, under the project lock.
   * @param project - the project.
   * @param origin - who decided.
   * @param params - the decision.
   * @returns the record.
   */
  private writeDecision(
    project: ProjectId,
    origin: RecordOrigin,
    params: { proposal: RecordId; decision: "accepted" | "rejected"; record?: RecordId },
  ): Promise<ProjectRecord> {
    const { store } = this.deps;
    return store.lock(project, () =>
      store.appendOutsideHistory(project, {
        parents: [store.requireLine(project).at],
        kind: "operation",
        component: "proj",
        operation: DECIDE_OPERATION,
        operation_version: "1",
        ...origin,
        params,
        inputs: [],
        outputs: [],
        based_on: null,
        supersedes: [],
        deterministic: true,
        status: "done",
      }),
    );
  }
}
