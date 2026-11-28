/**
 * The five operations of the generation component, built over the host's view of the workflows, the catalog and the
 * asset store (`OperationDeps`). `gen.run` runs a workflow on a catalog `graph` entry: the precondition refuses what
 * needs no server and asks the entry's `validate`; `execute` runs the batch (`count` runs, one after the other) and
 * imports each run's outputs after its `done`. The other four are a setting and three reads. The design is
 * `docs/archive/PLAN_2-3d.md`; the model for running on the catalog is `@cs/catalog`'s `contract.test.ts`.
 *
 * @module @cs/generation/operations
 */
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { NOT_QUEUED, RequestRejected } from "@cs/catalog";
import type { CatalogEntry, GraphRequest } from "@cs/catalog/types";
import type { ApiGraph } from "@cs/comfy/workflow";
import { OperationFailure, ProjectError } from "@cs/project";
import type { OperationSpec } from "@cs/project";
import type {
  AssetId,
  AssetStore,
  OperationContext,
  ProjectRecord,
  ProjectState,
  RecordId,
  RecordStatus,
  RunRequest,
} from "@cs/project/types";
import { canonicalGraph } from "@cs/workflow/files";
import type { WorkflowItem, WorkflowTarget } from "@cs/workflow/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import { z as zod } from "zod";
import { graphForRun, parseRunParams, planRun, type GenPlan } from "./plan.ts";
import { getReport, listReport, requireBatch } from "./read.ts";
import { OPERATION_LABELS } from "./strings.ts";
import {
  GEN_COMPONENT,
  GEN_LIMITS,
  GEN_OPERATIONS,
  type GenRun,
  type GenRunReport,
  type GenTargetEntry,
  type GenTargetsReport,
} from "./types.ts";

/** What the operations need from the host. */
export interface OperationDeps {
  /** A workflow and its parsed graph; throws ProjectError `invalid_params` for an unknown one. */
  workflow(state: ProjectState, id: RecordId): { item: WorkflowItem; graph: ApiGraph };
  /**
   * The `graph` entry a request runs on: the given target, else the workflow's default, else the only entry. Throws
   * ProjectError `invalid_params` (a sentence that says to call cs_gen_targets and pass `target`) when none can be
   * chosen or the named one is not registered.
   */
  // oxlint-disable-next-line typescript/no-unnecessary-type-arguments -- "graph" is the only primitive today; it is not the default by design.
  entry(target: WorkflowTarget | undefined, fallback: WorkflowTarget | null): CatalogEntry<"graph">;
  /** Every `graph` entry with its facts, as the catalog's summary gives them. */
  targets(): Promise<GenTargetEntry[]>;
  /** The asset reader a run gets. */
  assets(): Pick<AssetStore, "get" | "read" | "url" | "has">;
  /** The media type of an asset; throws ProjectError `unknown_asset`. */
  mimeOf(asset: AssetId): string;
}

const BASE = {
  component: GEN_COMPONENT,
  version: "1",
  deterministic: false,
} as const;

/** The code of a run that failed without being refused or stopped. */
const RUN_FAILED = "run_failed";
/** The code of a run a stop ended. */
const STOPPED = "stopped";

const settingsSchema = zod.object({ agent_run: zod.boolean() });
const listSchema = zod
  .object({
    status: zod.enum(["pending", "running", "done", "failed", "cancelled"]).optional(),
    workflow: zod.string().optional(),
    limit: zod.number().int().optional(),
  })
  .strict();
const getSchema = zod.object({ record: zod.string().min(1) }).strict();
const reportSchema = zod.object({
  workflow_name: zod.string().optional(),
  runs: zod.array(
    zod.object({ outputs: zod.array(zod.string()), error: zod.unknown().optional() }),
  ),
});

/**
 * @param schema - a zod schema.
 * @param params - a call's params.
 * @returns the parsed params.
 * @throws ProjectError `invalid_params` when they do not parse; the message names the first problem.
 */
function parseParams<T>(schema: zod.ZodType<T>, params: Record<string, unknown>): T {
  const parsed = schema.safeParse(params);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : ` (${issue.path.join(".")})`;
  throw new ProjectError("invalid_params", `The parameters are not valid${where}.`);
}

/**
 * @param count - a count.
 * @param noun - a singular noun.
 * @returns the count with the noun, plural when it is not one.
 */
function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Resolve the assets of the call's `media` inputs against the current history.
 * @param request - a call.
 * @param state - the project's current state, to find the output a `{record, output}` input names.
 * @returns the assets in input order (an asset may repeat).
 * @throws ProjectError `invalid_inputs` for a reference this function cannot resolve against the current history (a
 *   step outside it, an output the step does not have, or a version reference). The runner resolves such references
 *   through the record store, so letting them pass unchecked would bypass the preconditions.
 */
function mediaAssets(request: RunRequest, state: ProjectState): AssetId[] {
  const found: AssetId[] = [];
  for (const input of request.inputs) {
    if (input.role !== "media") continue;
    const ref = input.ref;
    if ("asset" in ref) {
      found.push(ref.asset);
    } else if ("record" in ref) {
      const producer = state.components.proj.records.find((record) => record.id === ref.record);
      const output = producer?.outputs[ref.output];
      if (output === undefined) throw unresolvable();
      found.push(output);
    } else {
      throw unresolvable();
    }
  }
  return found;
}

/** @returns the refusal for an input reference that names no asset of the current history. */
function unresolvable(): ProjectError {
  return new ProjectError(
    "invalid_inputs",
    "A media input does not name an asset this call can check. Name assets by asset ID (from cs_asset_list), or by " +
      "<record>#<n> of a step in the current history.",
  );
}

/**
 * @param error - a thrown value.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param record - a finished `gen.run` record.
 * @returns the batch's name for a summary: the label, else the workflow's name from the report.
 */
function nameOf(record: ProjectRecord): string {
  const label = record.params["label"];
  if (typeof label === "string" && label.trim() !== "") return label.trim();
  const report = reportSchema.safeParse(record.report);
  return report.success ? (report.data.workflow_name ?? "generation") : "generation";
}

/**
 * @param status - a record's status.
 * @returns whether the record has not ended.
 */
function unfinished(status: RecordStatus): boolean {
  return status === "pending" || status === "running";
}

/** The target param, shaped as the catalog key of an entry. */
const TARGET_SPEC = {
  type: "object",
  properties: {
    provider: { type: "string", required: true, description: "The catalog entry's provider." },
    target: { type: "string", required: true, description: "The catalog entry's target." },
  },
  additionalProperties: false,
  description: "The place to run on: the provider and target of an entry from cs_gen_targets.",
} as const;

/**
 * @param deps - what the host provides.
 * @returns the `gen.run` operation. The host registers it only while the catalog holds a `graph` entry.
 */
export function runOperation(deps: OperationDeps): OperationSpec {
  /** Check a call and build its plan; the inputs of the call are resolved against `state`. */
  const planOf = (request: RunRequest, state: ProjectState) => {
    const params = parseRunParams(request.params);
    const workflow = deps.workflow(state, params.workflow);
    const assets = mediaAssets(request, state);
    const plan = planRun(request.params, workflow, assets.length);
    return { params, workflow, assets, plan };
  };

  return {
    ...BASE,
    name: GEN_OPERATIONS.run,
    label: OPERATION_LABELS.run,
    description:
      "Run a workflow on a ComfyUI server. The call is queued and returns at once with status `pending`: call " +
      "cs_proj_wait with the record to wait, then read the outputs with cs_gen_get. `values` sets form fields by " +
      "field ID (see cs_workflow_get). `ops` is a one-off graph patch shaped like cs_workflow_save_variant's; the " +
      "workflow stays unchanged. For media inputs, pass assets in `inputs.media` and name the fields they fill, in " +
      "the same order, in `media_fields`. `count` repeats the run up to 4 times with fresh seeds. Give `target` " +
      "(from cs_gen_targets) when the workflow has no default place to run. Outputs enter the asset library as " +
      "pending; the user adopts them.",
    params: {
      workflow: {
        type: "string",
        required: true,
        description: "The workflow's ID, from the project summary or cs_workflow_list.",
      },
      values: {
        type: "object",
        additionalProperties: true,
        description:
          'Field values by field ID (`<node>.<input>`), such as {"6.text": "a red fox"}; a field left out keeps its default.',
      },
      ops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["set", "link", "add", "remove"], required: true },
          },
          additionalProperties: true,
        },
        description: "A graph patch for this run only, applied before `values`.",
      },
      media_fields: {
        type: "array",
        items: { type: "string" },
        description:
          "The field IDs the `media` inputs fill, one per input in the same order, each `<node>.<input>`.",
      },
      target: TARGET_SPEC,
      count: {
        type: "integer",
        description: `How many runs, 1 to ${String(GEN_LIMITS.count)}; default 1.`,
      },
      label: {
        type: "string",
        description: `A short name for the batch, up to ${String(GEN_LIMITS.labelChars)} characters; default the workflow's name.`,
      },
    },
    inputs: {
      media: {
        type: "any",
        description:
          "Assets that fill media fields of the graph (a reference image, an audio clip), by asset ID.",
        many: true,
      },
    },
    outputs: [{ role: "output", type: "any" }],
    resource: "gpu",
    background: true,
    agent: (state) => (state.components.gen?.settings.agent_run === true ? "run" : "propose"),
    omitParamsFromResult: true,
    summarize(record) {
      const name = nameOf(record);
      const report = reportSchema.safeParse(record.report);
      if (!report.success) {
        const count = record.params["count"];
        const runs = typeof count === "number" ? count : 1;
        if (unfinished(record.status)) return `queued "${name}" (${counted(runs, "run")})`;
        return record.status === "cancelled"
          ? `stopped "${name}" before it finished`
          : `failed "${name}"`;
      }
      const runs = report.data.runs;
      const finished = runs.filter((run) => run.error === undefined).length;
      return `ran "${name}": ${counted(record.outputs.length, "output")} from ${String(finished)} of ${counted(runs.length, "run")}`;
    },
    async precondition(request, state) {
      const { params, workflow, assets, plan } = planOf(request, state);
      // The kind of each asset must be the kind its field takes.
      assets.forEach((asset, index) => {
        const place = plan.media[index];
        const kind = place?.kind ?? null;
        if (place === undefined || kind === null) return;
        const mime = deps.mimeOf(asset);
        if (mime.split("/")[0] !== kind) {
          throw new ProjectError(
            "invalid_inputs",
            `Media input ${String(index + 1)} is ${mime}, but field '${place.field}' takes ${kind === "video" ? "a" : "an"} ${kind}.`,
          );
        }
      });
      const entry = deps.entry(params.target, workflow.item.target);
      const problems = await entry.validate({
        graph: plan.graph,
        media: plan.media.map(({ node, input }) => ({ node, input })),
      });
      if (problems.length > 0) throw new ProjectError("invalid_params", problems.join(" "));
    },
    async execute(context) {
      const params = parseRunParams(context.params);
      const workflow = deps.workflow(context.state, params.workflow);
      const assets = context.inputs
        .filter((input) => input.role === "media")
        .map((input) => {
          if (input.resolved_asset === null) throw new Error("A media input has no asset.");
          return input.resolved_asset;
        });
      const plan = planRun(context.params, workflow, assets.length);
      const entry = deps.entry(params.target, workflow.item.target);
      return await runBatch(deps, context, plan, entry, workflow, assets);
    },
  };
}

/**
 * Run the batch of a plan on an entry, one run after the other.
 * @param deps - the host.
 * @param context - the running record.
 * @param plan - the plan.
 * @param entry - the entry to run on.
 * @param workflow - the workflow.
 * @param assets - the assets of the `media` inputs, in order.
 * @returns the outputs of every finished run and the report.
 * @throws OperationFailure `not_queued` when the server refused every run, `run_failed` when no run finished
 *   otherwise; an Error when a stop ended the batch before any run finished (the runner ends such a record
 *   `cancelled`).
 */
async function runBatch(
  deps: OperationDeps,
  context: OperationContext,
  plan: GenPlan,
  // oxlint-disable-next-line typescript/no-unnecessary-type-arguments -- "graph" is the only primitive today; it is not the default by design.
  entry: CatalogEntry<"graph">,
  workflow: { item: WorkflowItem },
  assets: AssetId[],
): Promise<{ outputs: AssetId[]; report: Record<string, unknown> }> {
  const runs: GenRun[] = [];
  const outputs: AssetId[] = [];
  for (let index = 0; index < plan.count; index += 1) {
    // A stop leaves the runs that have not started unstarted.
    if (context.signal.aborted) break;
    const { graph, seeds } = graphForRun(plan, index);
    const request: GraphRequest = {
      graph,
      media: plan.media.map(({ node, input }, at) => ({
        node,
        input,
        asset: assets[at] ?? failMissing(at),
      })),
    };
    const dir = await mkdtemp(join(context.scratchDir, `run-${String(index + 1)}-`));
    let run: string | null = null;
    let done = false;
    const files: Array<{ name: string; mime: string; path: string }> = [];
    try {
      for await (const event of entry.run(request, {
        dir,
        assets: deps.assets(),
        signal: context.signal,
      })) {
        if (event.kind === "queued") run = event.run;
        else if (event.kind === "output") files.push(event);
        else if (event.kind === "done") done = true;
      }
      if (!done) throw new Error("The run ended without finishing.");
    } catch (error) {
      const code =
        error instanceof RequestRejected
          ? NOT_QUEUED
          : context.signal.aborted
            ? STOPPED
            : RUN_FAILED;
      runs.push({ run, seeds, outputs: [], error: { code, message: messageOf(error) } });
      continue;
    }
    // The files are imported after `done`, so a run that fails halfway leaves no asset behind. A failure of the import
    // itself (a full disk) is the run's failure, whatever the signal says; the files it did import stay listed.
    const made: AssetId[] = [];
    try {
      for (const file of files) {
        made.push(context.importAsset({ path: file.path }, { mime: file.mime, name: file.name }));
      }
      runs.push({ run, seeds, outputs: made });
    } catch (error) {
      runs.push({
        run,
        seeds,
        outputs: made,
        error: { code: RUN_FAILED, message: messageOf(error) },
      });
    }
    outputs.push(...made);
  }

  const finished = runs.filter((run) => run.error === undefined).length;
  const stopped =
    context.signal.aborted &&
    (runs.length < plan.count || runs.some((run) => run.error?.code === STOPPED));
  if (finished === 0) {
    // Nothing finished. A stop ends the record `cancelled`: the runner does that for an Error thrown after an abort.
    if (context.signal.aborted)
      throw new Error("The generation was stopped before any run finished.");
    const first = runs.find((run) => run.error !== undefined)?.error;
    if (first === undefined) throw new Error("The batch made no run.");
    throw runs.every((run) => run.error?.code === NOT_QUEUED)
      ? new OperationFailure(NOT_QUEUED, first.message)
      : new OperationFailure(RUN_FAILED, first.message);
  }
  // The prepared graph is kept only for a batch that has a report to name it.
  const graphBlob = context.importAsset(canonicalGraph(plan.graph), {
    mime: "application/json",
    name: `${plan.label}.graph.json`,
  });
  const report: GenRunReport = {
    workflow: workflow.item.id,
    workflow_name: workflow.item.name,
    target: { provider: entry.provider, target: entry.target },
    graph: graphBlob,
    values: plan.values,
    runs,
    ...(stopped ? { stopped: true } : {}),
  };
  return { outputs, report: { ...report } };
}

/**
 * @param index - the position of a media input that has no asset.
 * @returns never; the plan pairs one place with each asset, so this cannot happen.
 */
function failMissing(index: number): never {
  throw new Error(`Media input ${String(index + 1)} has no asset.`);
}

/**
 * @param deps - what the host provides.
 * @returns `gen.settings` and the three reads, which the host registers whenever the component is loaded.
 */
export function otherOperations(deps: OperationDeps): OperationSpec[] {
  const settings: OperationSpec = {
    ...BASE,
    name: GEN_OPERATIONS.settings,
    label: OPERATION_LABELS.settings,
    description:
      "Set whether an agent's generation runs at once (`agent_run` true) or only waits as a proposal for the " +
      "user to accept (false). Only the user does this, in the app; agents have no tool for it.",
    params: {
      agent_run: {
        type: "boolean",
        required: true,
        description: "Whether agents may run generations without asking.",
      },
    },
    inputs: {},
    outputs: [],
    resource: "none",
    agent: "none",
    outsideHistory: true,
    summarize: (record) =>
      record.params["agent_run"] === true
        ? "agents may run generations"
        : "agents propose generations",
    precondition(request) {
      parseParams(settingsSchema, request.params);
      return Promise.resolve();
    },
    execute: () => Promise.resolve({ outputs: [] }),
  };

  const targets: OperationSpec = {
    ...BASE,
    name: GEN_OPERATIONS.targets,
    label: OPERATION_LABELS.targets,
    description:
      "List the places a workflow can run: key (provider and target), name, kind, description and, for a place " +
      "whose server does not answer, why. Pass a place as `target` to cs_gen_run.",
    params: {},
    inputs: {},
    outputs: [],
    resource: "none",
    readOnly: true,
    summarize: () => "listed run targets",
    precondition: () => Promise.resolve(),
    async execute() {
      const report: GenTargetsReport = { targets: await deps.targets() };
      return { outputs: [], report: { ...report } };
    },
  };

  const list: OperationSpec = {
    ...BASE,
    name: GEN_OPERATIONS.list,
    label: OPERATION_LABELS.list,
    description:
      "List recent generation batches, newest first: record ID, label, workflow, status, runs asked for and " +
      "outputs made so far. Filter by `status` or `workflow`; `limit` is 1 to 50, default 10. Read one with cs_gen_get.",
    params: {
      status: {
        type: "string",
        enum: ["pending", "running", "done", "failed", "cancelled"],
        description: "Only batches in this status.",
      },
      workflow: { type: "string", description: "Only batches of this workflow ID." },
      limit: {
        type: "integer",
        description: `Batches to list, 1 to ${String(GEN_LIMITS.listLimit)}; default ${String(GEN_LIMITS.listDefault)}.`,
      },
    },
    inputs: {},
    outputs: [],
    resource: "none",
    readOnly: true,
    summarize: () => "listed generations",
    precondition(request) {
      parseParams(listSchema, request.params);
      return Promise.resolve();
    },
    execute(context) {
      const params = parseParams(listSchema, context.params);
      return Promise.resolve({
        outputs: [],
        report: { ...listReport(context.state, params) },
      });
    },
  };

  const get: OperationSpec = {
    ...BASE,
    name: GEN_OPERATIONS.get,
    label: OPERATION_LABELS.get,
    description:
      "Read one generation batch by its record ID: for each run its seeds, its output assets (ID, type, name, URL, " +
      "review state) and its error, the values used, and the batch's error. A queued batch has no runs yet; wait " +
      "for it with cs_proj_wait.",
    params: {
      record: {
        type: "string",
        required: true,
        description: "The batch's record ID, from cs_gen_run or cs_gen_list.",
      },
    },
    inputs: {},
    outputs: [],
    resource: "none",
    readOnly: true,
    summarize: () => "read a generation",
    precondition(request, state) {
      requireBatch(state, brandString<RecordId>(parseParams(getSchema, request.params).record));
      return Promise.resolve();
    },
    execute(context) {
      const params = parseParams(getSchema, context.params);
      return Promise.resolve({
        outputs: [],
        report: {
          ...getReport(context.state, brandString<RecordId>(params.record), deps.assets()),
        },
      });
    },
  };

  return [settings, targets, list, get];
}
