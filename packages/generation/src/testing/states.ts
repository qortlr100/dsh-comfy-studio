/**
 * Hand-built project states for the tests of the pure modules: records of `gen.run` in any status and the slices the
 * reads look at, without a mounted project layer.
 *
 * @module @cs/generation/testing/states
 */
import type {
  AssetId,
  ProjectRecord,
  ProjectState,
  RecordId,
  RecordStatus,
} from "@cs/project/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import { standIn } from "@cs/project/testing/support";
import type { WorkflowItem } from "@cs/workflow/types";
import type { GenSlice } from "../types.ts";

/**
 * @param id - the record ID text.
 * @param fields - what differs from a done, empty `gen.run` record of workflow `wf`.
 * @returns the record.
 */
export function recordOf(id: string, fields: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: brandString<RecordId>(id),
    parents: [],
    kind: "operation",
    component: "gen",
    operation: "gen.run",
    operation_version: "1",
    actor: "user",
    surface: "view",
    turn: null,
    session: null,
    tool_call: null,
    intent: "test",
    params: { workflow: "wf" },
    inputs: [],
    outputs: [],
    based_on: null,
    supersedes: [],
    deterministic: false,
    status: "done",
    created_at: `2026-11-29T00:00:${id.padStart(2, "0").slice(-2)}.000Z`,
    ...fields,
  };
}

/**
 * @param id - an asset ID text.
 * @returns the branded asset ID.
 */
export function assetOf(id: string): AssetId {
  return brandString<AssetId>(id);
}

/** What a state is built from. */
export interface StateOptions {
  records?: ProjectRecord[];
  gen?: GenSlice;
  /** Workflows by ID and name. */
  workflows?: Record<string, string>;
  /** The review state of each asset, in the shape of the asset component's slice (read by shape, not by type). */
  reviews?: Record<string, string>;
}

/**
 * @param options - the records and slices.
 * @returns a project state over them, oldest record first.
 */
export function stateOf(options: StateOptions = {}): ProjectState {
  const items: Record<string, Pick<WorkflowItem, "id" | "name">> = {};
  for (const [id, name] of Object.entries(options.workflows ?? {})) {
    items[id] = { id: brandString<RecordId>(id), name };
  }
  const components: Record<string, unknown> = {
    proj: {
      records: options.records ?? [],
      stale: {},
      superseded: {},
      created_by: {},
      proposals: {},
    },
  };
  if (options.gen !== undefined) components["gen"] = options.gen;
  if (options.workflows !== undefined) components["workflow"] = { items };
  if (options.reviews !== undefined) {
    components["asset"] = {
      items: Object.fromEntries(
        Object.entries(options.reviews).map(([id, review]) => [id, { review }]),
      ),
    };
  }
  return standIn<ProjectState>({ head: "head", project: { id: "p" }, components });
}

/**
 * @param status - a status.
 * @param extra - fields of the record.
 * @returns a numbered `gen.run` record in that status.
 */
export function batch(
  id: string,
  status: RecordStatus,
  extra: Partial<ProjectRecord> = {},
): ProjectRecord {
  return recordOf(id, { status, ...extra });
}
