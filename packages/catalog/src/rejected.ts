/**
 * The refusal of a request by an entry's server, and the record failure code that callers give such a call.
 *
 * @module @cs/catalog/rejected
 */

/**
 * The failure code of a record whose request the server refused without executing it. A caller that runs an entry
 * inside an operation fails the record with this code (`OperationFailure` of `@cs/project`) when the run rejects with
 * {@link RequestRejected}; what counts runs, such as a generation list or a batch, leaves records with this code out.
 */
export const NOT_QUEUED = "not_queued";

/**
 * An entry's server refused a request without executing it. `run` rejects with it before any event when the server
 * answers the submission itself, and after `queued` when the server only tells later, as a job queue does.
 */
export class RequestRejected extends Error {
  /** Every reason the server gave, each one sentence the agent can read; never empty. */
  readonly problems: string[];

  /**
   * @param problems - the reasons; an empty list becomes one general reason.
   */
  constructor(problems: readonly string[]) {
    const reasons = problems.length === 0 ? ["The server refused the request."] : [...problems];
    super(reasons.join(" "));
    this.name = "RequestRejected";
    this.problems = reasons;
  }
}
