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
  | "nothing_to_redo";

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

/**
 * The key of a project tool result's persisted metadata that holds the `ProjectShown` of what the result showed;
 * the operation tools and the `cs_proj_*` tools write it, the `project-updates` module reads it.
 */
export const SEEN_META_KEY = "cs_seen";
