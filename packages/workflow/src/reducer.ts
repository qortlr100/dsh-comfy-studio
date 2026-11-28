/**
 * The reducer of the workflow component: it turns the done records of the workflow operations into the `workflow`
 * state slice (a project's workflows). The rules are in `docs/archive/PLAN_2-3c.md` ("상태 조각").
 *
 * The reducer is pure and never throws. The `params` and `report` of a record are outside data to it: a record whose
 * params or report do not parse is skipped. The graphs are blobs in the asset store; the slice holds only their IDs.
 *
 * @module @cs/workflow/reducer
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import { z as zod } from "zod";
import type { AssetId, ProjectRecord, Reducer, RecordId } from "@cs/project/types";
import { workflowParamSchema } from "@cs/comfy/workflow";
import { ellipsize, trimField } from "./files.ts";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_OPERATIONS,
  type WorkflowItem,
  type WorkflowSlice,
  type WorkflowTarget,
} from "./types.ts";

/** The most field IDs the agent summary lists for one workflow. */
const SUMMARY_FIELDS = 30;

const targetSchema = zod.object({ provider: zod.string(), target: zod.string() });
const fieldsSchema = zod.array(workflowParamSchema).max(WORKFLOW_LIMITS.fields);

const madeReportSchema = zod.object({
  graph: zod.string().min(1),
  fields: fieldsSchema,
  nodes: zod.number().int().nonnegative(),
  name: zod.string(),
  description: zod.string(),
});
const updateReportSchema = zod.object({ fields: fieldsSchema.optional() });

const createParamsSchema = zod.object({ target: targetSchema.nullish() });
const variantParamsSchema = zod.object({ workflow: zod.string() });
const copyParamsSchema = zod.object({ project: zod.string(), workflow: zod.string() });
const updateParamsSchema = zod.object({
  workflow: zod.string(),
  name: zod.string().optional(),
  description: zod.string().optional(),
  // Absent leaves the target; null clears it.
  target: targetSchema.nullable().optional(),
});
const deleteParamsSchema = zod.object({ workflow: zod.string() });

/** @returns the slice before any record. */
export function emptySlice(): WorkflowSlice {
  return { items: {} };
}

/**
 * @param slice - the slice.
 * @param key - a workflow ID as text.
 * @returns the workflow, or undefined for none (an own key only).
 */
function find(slice: WorkflowSlice, key: string): WorkflowItem | undefined {
  return Object.hasOwn(slice.items, key) ? slice.items[brandString<RecordId>(key)] : undefined;
}

/**
 * Add the workflow a creating record made.
 * @param slice - the slice before.
 * @param record - a done `create`, `save_variant` or `copy` record.
 * @param parent - the workflow the new one is a variant of, when it is in the slice.
 * @param target - the default run target the new workflow gets.
 * @returns the slice after; the same slice when the report does not parse.
 */
function addItem(
  slice: WorkflowSlice,
  record: ProjectRecord,
  parent: WorkflowItem | null,
  target: WorkflowTarget | null,
): WorkflowSlice {
  const report = madeReportSchema.safeParse(record.report);
  if (!report.success) return slice;
  const item: WorkflowItem = {
    id: record.id,
    name: report.data.name,
    description: report.data.description,
    graph: brandString<AssetId>(report.data.graph),
    fields: report.data.fields.map(trimField),
    parent: parent === null ? null : parent.id,
    target,
    nodes: report.data.nodes,
    created_at: record.created_at,
    updated_at: record.created_at,
  };
  return { items: { ...slice.items, [record.id]: item } };
}

/**
 * @param slice - the slice before.
 * @param record - a done `workflow.update` record.
 * @returns the slice after.
 */
function reduceUpdate(slice: WorkflowSlice, record: ProjectRecord): WorkflowSlice {
  const params = updateParamsSchema.safeParse(record.params);
  const report = updateReportSchema.safeParse(record.report ?? {});
  if (!params.success || !report.success) return slice;
  const item = find(slice, params.data.workflow);
  if (item === undefined) return slice;
  const next: WorkflowItem = { ...item, updated_at: record.created_at };
  if (params.data.name !== undefined) next.name = params.data.name.trim();
  if (params.data.description !== undefined) next.description = params.data.description.trim();
  if (report.data.fields !== undefined) next.fields = report.data.fields.map(trimField);
  if (params.data.target !== undefined) next.target = params.data.target;
  return { items: { ...slice.items, [item.id]: next } };
}

/**
 * @param slice - the slice before.
 * @param record - a done `workflow.delete` record.
 * @returns the slice without the workflow; its variants lose their parent.
 */
function reduceDelete(slice: WorkflowSlice, record: ProjectRecord): WorkflowSlice {
  const params = deleteParamsSchema.safeParse(record.params);
  if (!params.success) return slice;
  const gone = find(slice, params.data.workflow);
  if (gone === undefined) return slice;
  const items = { ...slice.items };
  Reflect.deleteProperty(items, gone.id);
  for (const item of Object.values(items)) {
    if (item.parent === gone.id) items[item.id] = { ...item, parent: null };
  }
  return { items };
}

/**
 * Apply one record to the slice.
 * @param slice - the slice before.
 * @param record - the record.
 * @returns the slice after.
 */
function reduceRecord(slice: WorkflowSlice, record: ProjectRecord): WorkflowSlice {
  if (record.status !== "done") return slice;
  switch (record.operation) {
    case WORKFLOW_OPERATIONS.create: {
      const params = createParamsSchema.safeParse(record.params);
      return params.success ? addItem(slice, record, null, params.data.target ?? null) : slice;
    }
    case WORKFLOW_OPERATIONS.saveVariant: {
      const params = variantParamsSchema.safeParse(record.params);
      if (!params.success) return slice;
      const parent = find(slice, params.data.workflow) ?? null;
      return addItem(slice, record, parent, parent === null ? null : parent.target);
    }
    case WORKFLOW_OPERATIONS.copy:
      return copyParamsSchema.safeParse(record.params).success
        ? addItem(slice, record, null, null)
        : slice;
    case WORKFLOW_OPERATIONS.update:
      return reduceUpdate(slice, record);
    case WORKFLOW_OPERATIONS.delete:
      return reduceDelete(slice, record);
    default:
      return slice;
  }
}

/** The reducer of the `workflow` slice. */
export const workflowReducer: Reducer<"workflow"> = {
  initial: emptySlice,
  reduce: (slice, record) => reduceRecord(slice ?? emptySlice(), record),
  agentSummary(slice) {
    const items = Object.values(slice?.items ?? {}).toSorted(
      (a, b) =>
        (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    if (items.length === 0) return {};
    const shown = items.slice(0, WORKFLOW_LIMITS.summaryItems);
    const more = items.length - shown.length;
    return {
      workflows: shown.map((item) => ({
        id: item.id,
        name: item.name,
        description: ellipsize(item.description, WORKFLOW_LIMITS.summaryDescriptionChars),
        fields: item.fields.slice(0, SUMMARY_FIELDS).map((field) => field.id),
        ...(item.fields.length > SUMMARY_FIELDS
          ? { fields_more: item.fields.length - SUMMARY_FIELDS }
          : {}),
      })),
      ...(more > 0 ? { workflows_more: more } : {}),
    };
  },
};
