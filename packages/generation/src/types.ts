/**
 * Types of the generation feature component: the `gen` state slice (one setting), the params and the report of a
 * run, and what its read operations answer.
 *
 * One `gen.run` request is one batch and one record: its `report` (a {@link GenRunReport}) holds every run of the
 * batch, and the record's outputs are the outputs of all runs. Views and the read operations list batches from the
 * project's records; the slice does not repeat them.
 *
 * This file is the client face `@cs/generation/types`: it imports no host module, so a browser half can read it. The
 * design is `docs/archive/PLAN_2-3d.md`.
 *
 * @module @cs/generation/types
 */
import type { GraphPatch } from "@cs/comfy/graph-patch";
import type { AssetId, RecordId, RecordStatus } from "@cs/project/types";
import type { WorkflowTarget } from "@cs/workflow/types";

/** The component key, the prefix of every operation name, and the key of the state slice. */
export const GEN_COMPONENT = "gen";

/** The operation names of the component. */
export const GEN_OPERATIONS = {
  run: "gen.run",
  settings: "gen.settings",
  targets: "gen.targets",
  list: "gen.list",
  get: "gen.get",
} as const;

/** The limits the operations enforce before a record is written. */
export const GEN_LIMITS = {
  /** The most runs of one batch. */
  count: 4,
  labelChars: 100,
  /** The most media inputs of one request. */
  mediaInputs: 16,
  listLimit: 50,
  listDefault: 10,
  /** Batches the agent summary lists. */
  summaryItems: 5,
} as const;

/** The `gen` state slice. */
export interface GenSlice {
  settings: {
    /** Whether an agent's call of `gen.run` runs at once (true) or writes a proposal (false, the default). */
    agent_run: boolean;
  };
}

/** A value of a workflow field. */
export type FieldValue = string | number | boolean;

/** The params of `gen.run`. */
export interface GenRunParams {
  /** The workflow to run. */
  workflow: RecordId;
  /** Field values by field ID (`<node>.<input>`); a field left out keeps its default. */
  values?: Record<string, FieldValue>;
  /** A graph patch applied to the template before the values; the workflow itself is not changed. */
  ops?: GraphPatch;
  /** The field IDs (`<node>.<input>`) that the `media` inputs fill, in the order of those inputs. */
  media_fields?: string[];
  /** The catalog entry to run on; the workflow's default, or the only entry, when left out. */
  target?: WorkflowTarget;
  /** How many runs, 1 to `GEN_LIMITS.count`; 1 when left out. */
  count?: number;
  /** A short name for the batch. */
  label?: string;
}

/** One run of a batch. */
export interface GenRun {
  /** The provider's ID of the run; null when the server never accepted it. */
  run: string | null;
  /** The seeds this run used, by field ID. */
  seeds: Record<string, number>;
  /** The assets this run made. */
  outputs: AssetId[];
  /** Why the run did not finish; absent for a finished run. `not_queued`: the server refused the request. */
  error?: { code: string; message: string };
}

/** What a `gen.run` record leaves in its `report`. */
export interface GenRunReport {
  workflow: RecordId;
  /** The workflow's name when the batch ran. */
  workflow_name: string;
  target: WorkflowTarget;
  /** The graph that was prepared (template, patch, values; before the seeds of each run), a canonical JSON blob. */
  graph: AssetId;
  /** The field values the request gave, after coercion. */
  values: Record<string, FieldValue>;
  /** The runs, in order; fewer than the requested count when the batch was stopped. */
  runs: GenRun[];
  /** True when a stop ended the batch before every run was done. */
  stopped?: boolean;
}

/** One place a workflow can run, as `gen.targets` answers it. */
export interface GenTargetEntry {
  provider: string;
  target: string;
  /** The name the entry gives itself; null when its server did not answer. */
  label: string | null;
  /** The provider's word for the kind of server; null when its server did not answer. */
  kind: string | null;
  description: string;
  /** Why the server did not answer; null when it did. */
  problem: string | null;
}

/** What `gen.targets` answers in its report. */
export interface GenTargetsReport {
  targets: GenTargetEntry[];
}

/** One batch as `gen.list` answers it. */
export interface GenListEntry {
  record: RecordId;
  label: string;
  workflow: RecordId;
  workflow_name: string;
  status: RecordStatus;
  /** The number of runs asked for. */
  count: number;
  /** The number of assets made so far. */
  outputs: number;
  created_at: string;
  /** The record's error message; absent unless it failed or was stopped. */
  error?: string;
}

/** What `gen.list` answers in its report. */
export interface GenListReport {
  batches: GenListEntry[];
}

/** One output of a batch as `gen.get` answers it. */
export interface GenOutput {
  asset: AssetId;
  mime: string;
  name: string;
  url: string;
  /** The asset's review state in the library; null when the asset component is not loaded or the asset left it. */
  review: string | null;
}

/** What `gen.get` answers in its report. */
export interface GenGetReport {
  record: RecordId;
  label: string;
  status: RecordStatus;
  workflow: RecordId;
  workflow_name: string;
  target: WorkflowTarget | null;
  values: Record<string, FieldValue>;
  runs: Array<{
    run: string | null;
    seeds: Record<string, number>;
    outputs: GenOutput[];
    error?: { code: string; message: string };
  }>;
  /** The record's error; absent unless it failed or was stopped. */
  error?: { code: string; message: string };
}

declare module "@cs/project/types" {
  interface ComponentStates {
    /** The generation settings; absent while the generation component is not loaded. */
    gen?: GenSlice;
  }
}
