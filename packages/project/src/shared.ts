/**
 * Values that several modules of the Project service use: the error classes, and the metadata key of what a tool result
 * showed of the project.
 *
 * @module @cs/project/shared
 */

/** Why a Project call was refused. The record store, the runner and history throw these codes. */
export type ProjectErrorCode =
  | "unknown_project"
  | "unknown_record"
  | "unknown_operation"
  | "unknown_asset"
  | "invalid_params"
  | "invalid_inputs"
  | "input_not_ready"
  | "component_exists"
  | "kind_exists"
  | "operation_exists"
  | "reducer_exists"
  | "parent_not_head"
  | "status_backwards"
  | "record_finished"
  | "nothing_to_undo"
  | "nothing_to_redo"
  /** An agent's request for an operation whose `agent` is `propose` or `none`. */
  | "agent_not_allowed"
  /** A decision on a proposal while another decision on it is in flight. */
  | "proposal_busy";

/** A Project call was refused before it changed anything; `code` says why. */
export class ProjectError extends Error {
  readonly code: ProjectErrorCode;

  /**
   * @param code - why the call was refused.
   * @param message - the explanation, in words a creator can read.
   */
  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.code = code;

    this.name = "ProjectError";
  }
}

/** The failure codes that the runner itself writes; an operation cannot choose them. */
const RUNNER_FAILURE_CODES = new Set(["operation_failed", "input_failed", "stopped", "discarded"]);

/**
 * A failure that an operation's `execute` throws to fail its record with a code of its own instead of
 * `operation_failed`, so that reducers and views can tell this kind of failure apart without reading the message.
 */
export class OperationFailure extends Error {
  readonly code: string;

  /**
   * @param code - the record's failure code: lower-case words joined by `_`, and none of the runner's own codes.
   * @param message - the explanation, in words a creator can read.
   * @throws TypeError when `code` has another shape or is one of the runner's codes.
   */
  constructor(code: string, message: string) {
    if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(code) || RUNNER_FAILURE_CODES.has(code)) {
      throw new TypeError(`"${code}" cannot be the failure code of an operation.`);
    }
    super(message);
    this.code = code;

    this.name = "OperationFailure";
  }
}

/**
 * The key of a project tool result's persisted metadata that holds the `ProjectShown` of what the result showed;
 * the operation tools and the `cs_proj_*` tools write it, the `project-updates` module reads it.
 */
export const SEEN_META_KEY = "cs_seen";
