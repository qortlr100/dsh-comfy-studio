/**
 * The reports of the generation read operations (`gen.list`, `gen.get`) and the agent summary, as pure functions of
 * a project's state. The batches are the `gen.run` records of `state.components.proj.records`; the `params` and the
 * `report` of a record are outside data (a record on disk), so they are read with zod and a record that does not parse
 * is skipped or read as far as it goes. The report types are in `types.ts`.
 *
 * @module @cs/generation/read
 */
import { ProjectError } from "@cs/project";
import type {
  AssetId,
  AssetStore,
  ProjectRecord,
  ProjectState,
  RecordId,
  RecordStatus,
} from "@cs/project/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import { z as zod } from "zod";
import {
  GEN_LIMITS,
  GEN_OPERATIONS,
  type FieldValue,
  type GenGetReport,
  type GenListEntry,
  type GenListReport,
  type GenOutput,
} from "./types.ts";

/** What `gen.list` filters by. */
export interface ListQuery {
  status?: RecordStatus | undefined;
  workflow?: string | undefined;
  limit?: number | undefined;
}

/** The `generation` field of the agent summary. */
export type GenSummary = {
  agent_may_run: boolean;
  /** Batches that are queued or running. */
  unfinished: number;
  /** The last batches, newest first; absent when there are none. */
  recent?: Array<{ id: string; label: string; status: RecordStatus; outputs: number }>;
};

const fieldValue = zod.union([zod.string(), zod.number(), zod.boolean()]);
const runParamsSchema = zod.object({
  workflow: zod.string(),
  values: zod.record(zod.string(), fieldValue).optional(),
  label: zod.string().optional(),
  count: zod.number().optional(),
});
const runSchema = zod.object({
  run: zod.string().nullable(),
  seeds: zod.record(zod.string(), zod.number()),
  outputs: zod.array(zod.string()),
  error: zod.object({ code: zod.string(), message: zod.string() }).optional(),
});
const reportSchema = zod.object({
  workflow_name: zod.string().optional(),
  target: zod.object({ provider: zod.string(), target: zod.string() }).optional(),
  values: zod.record(zod.string(), fieldValue).optional(),
  runs: zod.array(runSchema).optional(),
});

/**
 * @param value - any value.
 * @returns whether it is an object that can be read by key.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * @param state - a project's state.
 * @returns the `gen.run` records of the history list, newest first.
 */
function batchesOf(state: ProjectState): ProjectRecord[] {
  return state.components.proj.records
    .filter((record) => record.operation === GEN_OPERATIONS.run)
    .toReversed();
}

/**
 * @param record - a `gen.run` record.
 * @param state - the project's state, for the name of the workflow.
 * @returns the batch's name: its label, else the workflow's name when the batch ran, else the workflow's current
 *   name; "generation" when nothing names it.
 */
function labelOf(record: ProjectRecord, state: ProjectState): string {
  const params = runParamsSchema.safeParse(record.params);
  const report = reportSchema.safeParse(record.report);
  const label = params.success ? params.data.label?.trim() : undefined;
  if (label !== undefined && label !== "") return label;
  const ran = report.success ? report.data.workflow_name : undefined;
  if (ran !== undefined) return ran;
  const item = params.success
    ? state.components.workflow?.items[brandString<RecordId>(params.data.workflow)]
    : undefined;
  return item?.name ?? "generation";
}

/**
 * @param state - a project's state.
 * @param query - the filters and the page size.
 * @returns the report of `gen.list`: the `gen.run` records, newest first, filtered; a record whose params do not
 *   parse is skipped; one without a report yet (queued or running) still lists, with no outputs counted.
 */
export function listReport(state: ProjectState, query: ListQuery = {}): GenListReport {
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? GEN_LIMITS.listDefault), 1),
    GEN_LIMITS.listLimit,
  );
  const batches: GenListEntry[] = [];
  for (const record of batchesOf(state)) {
    if (batches.length >= limit) break;
    const params = runParamsSchema.safeParse(record.params);
    if (!params.success) continue;
    if (query.status !== undefined && record.status !== query.status) continue;
    if (query.workflow !== undefined && params.data.workflow !== query.workflow) continue;
    const report = reportSchema.safeParse(record.report);
    const item = state.components.workflow?.items[brandString<RecordId>(params.data.workflow)];
    batches.push({
      record: record.id,
      label: labelOf(record, state),
      workflow: brandString<RecordId>(params.data.workflow),
      workflow_name:
        (report.success ? report.data.workflow_name : undefined) ??
        item?.name ??
        params.data.workflow,
      status: record.status,
      count: params.data.count ?? 1,
      outputs: record.outputs.length,
      created_at: record.created_at,
      ...(record.error === undefined ? {} : { error: record.error.message }),
    });
  }
  return { batches };
}

/**
 * @param state - a project's state.
 * @param asset - an asset ID.
 * @returns the asset's review state in the library (`pending`, `adopted`, `held`); null when the asset component is
 *   not loaded or the library does not hold the asset. The library slice is read by shape: this package does not
 *   depend on the asset component.
 */
export function reviewOf(state: ProjectState, asset: AssetId): string | null {
  const slice: unknown = Reflect.get(state.components, "asset");
  if (!isObject(slice) || !isObject(slice["items"])) return null;
  const item = slice["items"][asset];
  return isObject(item) && typeof item["review"] === "string" ? item["review"] : null;
}

/**
 * @param state - a project's state.
 * @param id - a record ID a call names.
 * @returns the `gen.run` record of the history list.
 * @throws ProjectError `invalid_params` when there is none.
 */
export function requireBatch(state: ProjectState, id: RecordId): ProjectRecord {
  const record = batchesOf(state).find((candidate) => candidate.id === id);
  if (record === undefined) {
    throw new ProjectError("invalid_params", `Unknown generation '${String(id)}'.`);
  }
  return record;
}

/**
 * @param run - a run as the report stores it.
 * @param state - the project's state, for the review states.
 * @param assets - the asset reader.
 * @returns the run with its outputs read from the store; an output the store no longer has is left out.
 */
function readRun(
  run: zod.infer<typeof runSchema>,
  state: ProjectState,
  assets: Pick<AssetStore, "get" | "url" | "has">,
): GenGetReport["runs"][number] {
  const outputs: GenOutput[] = [];
  for (const raw of run.outputs) {
    const asset = brandString<AssetId>(raw);
    if (!assets.has(asset)) continue;
    const facts = assets.get(asset);
    outputs.push({
      asset,
      mime: facts.mime,
      name: facts.name,
      url: assets.url(asset),
      review: reviewOf(state, asset),
    });
  }
  return {
    run: run.run,
    seeds: run.seeds,
    outputs,
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

/**
 * @param state - a project's state.
 * @param id - a batch's record ID.
 * @param assets - the asset reader.
 * @returns the report of `gen.get`: the runs with their seeds, outputs and errors, and the values used. A batch that
 *   has no report yet (queued or running) answers with no runs and the values it was asked for.
 * @throws ProjectError `invalid_params` when the project has no such `gen.run` record.
 */
export function getReport(
  state: ProjectState,
  id: RecordId,
  assets: Pick<AssetStore, "get" | "url" | "has">,
): GenGetReport {
  const record = requireBatch(state, id);
  const params = runParamsSchema.safeParse(record.params);
  const report = reportSchema.safeParse(record.report);
  const values: Record<string, FieldValue> =
    (report.success ? report.data.values : undefined) ??
    (params.success ? params.data.values : undefined) ??
    {};
  const workflow = brandString<RecordId>(params.success ? params.data.workflow : "");
  return {
    record: record.id,
    label: labelOf(record, state),
    status: record.status,
    workflow,
    workflow_name:
      (report.success ? report.data.workflow_name : undefined) ??
      state.components.workflow?.items[workflow]?.name ??
      String(workflow),
    target: report.success ? (report.data.target ?? null) : null,
    values,
    runs: (report.success ? (report.data.runs ?? []) : []).map((run) =>
      readRun(run, state, assets),
    ),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

/**
 * @param state - a project's state.
 * @returns the `generation` field of the agent summary: whether an agent's call runs at once, how many batches are
 *   unfinished, and the last `GEN_LIMITS.summaryItems` batches, newest first (no `recent` without batches).
 */
export function summaryOf(state: ProjectState): GenSummary {
  const batches = batchesOf(state);
  const summary: GenSummary = {
    agent_may_run: state.components.gen?.settings.agent_run === true,
    unfinished: batches.filter(
      (record) => record.status === "pending" || record.status === "running",
    ).length,
  };
  if (batches.length > 0) {
    summary.recent = batches.slice(0, GEN_LIMITS.summaryItems).map((record) => ({
      id: record.id,
      label: labelOf(record, state),
      status: record.status,
      outputs: record.outputs.length,
    }));
  }
  return summary;
}
