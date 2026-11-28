/**
 * Types of the workflow feature component: the `workflow` state slice (a project's ComfyUI workflows: graph templates
 * with exposed fields) and what its read operations answer.
 *
 * This file is the client face `@cs/workflow/types`: it imports no host module, so a browser half can read it. The
 * design is `docs/archive/PLAN_2-3c.md`.
 *
 * @module @cs/workflow/types
 */
import type { GraphProblem } from "@cs/comfy/graph-patch";
import type { WorkflowParam } from "@cs/comfy/workflow";
import type { AssetId, ProjectId, RecordId } from "@cs/project/types";

/** The component key, the prefix of every operation name, and the key of the state slice. */
export const WORKFLOW_COMPONENT = "workflow";

/** The operation names of the component. */
export const WORKFLOW_OPERATIONS = {
  create: "workflow.create",
  update: "workflow.update",
  saveVariant: "workflow.save_variant",
  copy: "workflow.copy",
  delete: "workflow.delete",
  list: "workflow.list",
  get: "workflow.get",
  graph: "workflow.graph",
  checkPatch: "workflow.check_patch",
} as const;

/** The limits the operations enforce before a record is written. */
export const WORKFLOW_LIMITS = {
  /** The most bytes of an uploaded graph file. */
  fileBytes: 5 * 1024 * 1024,
  nameChars: 100,
  descriptionChars: 2000,
  /** The most exposed fields of one workflow. */
  fields: 100,
  /** A field with more choices than this is stored without its choices. */
  fieldOptions: 50,
  /** The most characters of a text default `workflow.update` takes into a record's params. */
  fieldDefaultChars: 20_000,
  /** The most characters `workflow.graph` answers as node lines; a longer graph answers its outline. */
  graphTextChars: 12_000,
  /** How long an operation waits for a server's node catalog, in milliseconds. */
  nodeCatalogWaitMs: 20_000,
  /** Workflows the agent summary lists. */
  summaryItems: 30,
  /** Characters of a description in the agent summary and in `workflow.list`. */
  summaryDescriptionChars: 160,
} as const;

/** The catalog `graph` entry a workflow runs on by default: the entry's provider and target. */
export interface WorkflowTarget {
  provider: string;
  target: string;
}

/** One workflow of the project. */
export interface WorkflowItem {
  /** The record that created the workflow. */
  id: RecordId;
  name: string;
  description: string;
  /** The graph: a JSON blob in the asset store (API format, canonical: nodes in ID order, keys sorted). */
  graph: AssetId;
  /** The exposed form fields; a media field's default is only the file name the template names. */
  fields: WorkflowParam[];
  /** The workflow this one is a variant of; null for an uploaded or copied one, or once the parent is deleted. */
  parent: RecordId | null;
  /** The catalog entry to run on by default; null when none was chosen. */
  target: WorkflowTarget | null;
  /** The number of nodes of the graph. */
  nodes: number;
  /** When the creating record was written, ISO-8601 UTC. */
  created_at: string;
  /** When the workflow was last created or updated, ISO-8601 UTC. */
  updated_at: string;
}

/** The `workflow` state slice. */
export interface WorkflowSlice {
  /** The workflows, by ID. A deleted workflow is not here. */
  items: Record<RecordId, WorkflowItem>;
}

/**
 * What the records that make a workflow (`workflow.create`, `workflow.save_variant`, `workflow.copy`) leave in their
 * `report`, for the reducer.
 */
export interface WorkflowMadeReport {
  /** The canonical graph blob. */
  graph: AssetId;
  fields: WorkflowParam[];
  nodes: number;
  /** The workflow's name, as stored (trimmed, or taken from the file name or the source workflow). */
  name: string;
  description: string;
  /** Warnings of the graph check that did not stop the call, one sentence each; absent for none. */
  warnings?: string[];
}

/** What `workflow.update` leaves in its `report`: the checked fields, when the call changed them. */
export interface WorkflowUpdateReport {
  fields?: WorkflowParam[];
}

/** One workflow as `workflow.list` answers it. */
export interface WorkflowListEntry {
  id: RecordId;
  name: string;
  /** Cut to `WORKFLOW_LIMITS.summaryDescriptionChars`. */
  description: string;
  nodes: number;
  /** The number of exposed fields. */
  fields: number;
  parent: RecordId | null;
  updated_at: string;
}

/** What `workflow.list` answers in its report. */
export interface WorkflowListReport {
  workflows: WorkflowListEntry[];
}

/** What `workflow.get` answers in its report. */
export interface WorkflowGetReport {
  id: RecordId;
  name: string;
  description: string;
  nodes: number;
  fields: WorkflowParam[];
  target: WorkflowTarget | null;
  /** The parent workflow; null for none. */
  parent: { id: RecordId; name: string } | null;
  /** The variants made from this workflow. */
  variants: Array<{ id: RecordId; name: string }>;
}

/** What `workflow.graph` answers in its report. */
export interface WorkflowGraphReport {
  workflow: RecordId;
  nodes: number;
  /** `nodes`: `text` is one line per node. `outline`: the graph was too long; `text` is its outline by class. */
  form: "nodes" | "outline";
  text: string;
}

/** What `workflow.check_patch` answers in its report. */
export interface WorkflowPatchReport {
  workflow: RecordId;
  /** False when the patch does not apply or makes a new error. */
  ok: boolean;
  /** Why the patch did not apply (the patch error with the index of the op); absent when it applied. */
  error?: string;
  /** The problems the patch made that the template did not have. */
  problems: GraphProblem[];
  /** IDs of the nodes the patch added. */
  added: string[];
  /** IDs of the nodes the patch removed. */
  removed: string[];
  /** The added and changed nodes after the patch, one line per node. */
  text: string;
  /** Whether a server's node catalog checked classes, input types and links; false for a structural check only. */
  checked_against_server: boolean;
}

/** The params of `workflow.copy`. */
export interface WorkflowCopyParams {
  project: ProjectId;
  workflow: RecordId;
}

declare module "@cs/project/types" {
  interface ComponentStates {
    /** The project's workflows; absent while the workflow component is not loaded. */
    workflow?: WorkflowSlice;
  }
}
