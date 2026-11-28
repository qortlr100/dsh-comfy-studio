/**
 * The plan of one `gen.run` request, as pure functions: check the params against the workflow and build the graph
 * (template, then the patch, then the field values), and give each run of the batch its own seeds. Nothing here
 * touches the project, the catalog or the asset store, so the precondition and the execution build the same plan from
 * the same params, and the tests need no mounted layer. The design is `docs/archive/PLAN_2-3d.md` ("그래프를 만드는 순서").
 *
 * @module @cs/generation/plan
 */
import { hasErrors } from "@cs/comfy/graph-patch";
import {
  applyParams,
  coerceParamValue,
  isLiteral,
  isMediaParam,
  ParamValueError,
  rebaseParams,
  randomSeed,
  type ApiGraph,
  type WorkflowParam,
} from "@cs/comfy/workflow";
import { ProjectError } from "@cs/project";
import type { RecordId } from "@cs/project/types";
import { applyPatch, parsePatch, problemLines } from "@cs/workflow/files";
import type { WorkflowItem, WorkflowTarget } from "@cs/workflow/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import { z as zod } from "zod";
import { GEN_LIMITS, type FieldValue } from "./types.ts";

/** The kinds of media a field takes. */
export type MediaKind = "image" | "audio" | "video";

/** The params of `gen.run` after they were read: the checks that need the workflow come later. */
export interface RunParams {
  workflow: RecordId;
  values: Record<string, FieldValue>;
  /** The patch as the caller wrote it; `parsePatch` reads it. */
  ops: unknown;
  mediaFields: string[];
  target: WorkflowTarget | undefined;
  count: number;
  label: string | undefined;
}

/** What `planRun` builds. */
export interface GenPlan {
  /** The graph after the patch and the values, before per-run seeds; media fields still hold the template's literals. */
  graph: ApiGraph;
  /** Where each media input goes, in the order of the request's `media` inputs. */
  media: Array<{
    node: string;
    input: string;
    /** The field ID `<node>.<input>`. */
    field: string;
    /** The kind of media the field takes; null for a literal input that is not a media field of the workflow. */
    kind: MediaKind | null;
  }>;
  /** The values the request gave, coerced, by field ID. */
  values: Record<string, FieldValue>;
  /** Every seed field of the workflow after the patch; each run draws them anew except where `fixedSeeds` holds one. */
  seedFields: WorkflowParam[];
  /**
   * The seeds the first run keeps, by field ID: a seed field the request gave a value, or that the patch pinned.
   * Later runs and the seed fields not named here draw anew.
   */
  fixedSeeds: Record<string, number>;
  count: number;
  /** The batch's name: the request's label, else the workflow's name. */
  label: string;
}

const targetSchema = zod.object({
  provider: zod.string().min(1).max(200),
  target: zod.string().min(1).max(200),
});

const paramsSchema = zod
  .object({
    workflow: zod.string().min(1),
    values: zod
      .record(zod.string(), zod.union([zod.string(), zod.number(), zod.boolean()]))
      .optional(),
    ops: zod.unknown().optional(),
    media_fields: zod.array(zod.string()).optional(),
    target: targetSchema.optional(),
    count: zod.number().optional(),
    label: zod.string().optional(),
  })
  .strict();

/**
 * @param params - the params of a `gen.run` call.
 * @returns the params, read; the count and the label are checked.
 * @throws ProjectError `invalid_params` for an unknown key, a value of the wrong type, a count outside
 *   1 to `GEN_LIMITS.count`, or a label over `GEN_LIMITS.labelChars` characters.
 */
export function parseRunParams(params: unknown): RunParams {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined || issue.path.length === 0 ? "" : ` (${issue.path.join(".")})`;
    const what =
      issue?.code === "unrecognized_keys" ? `: unknown parameter ${issue.keys.join(", ")}` : "";
    throw new ProjectError("invalid_params", `The parameters are not valid${where}${what}.`);
  }
  const data = parsed.data;
  const count = data.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > GEN_LIMITS.count) {
    throw new ProjectError(
      "invalid_params",
      `'count' must be a whole number from 1 to ${String(GEN_LIMITS.count)}.`,
    );
  }
  const label = data.label?.trim();
  if (label !== undefined && label.length > GEN_LIMITS.labelChars) {
    throw new ProjectError(
      "invalid_params",
      `'label' must have at most ${String(GEN_LIMITS.labelChars)} characters.`,
    );
  }
  return {
    workflow: brandString<RecordId>(data.workflow),
    values: data.values ?? {},
    ops: data.ops,
    mediaFields: data.media_fields ?? [],
    target: data.target,
    count,
    label: label === undefined || label === "" ? undefined : label,
  };
}

/**
 * @param field - a workflow field, if there is one.
 * @returns the kind of media the field takes, or null for a field that is not a media field.
 */
export function mediaKindOf(field: WorkflowParam | undefined): MediaKind | null {
  return field !== undefined && isMediaParam(field.type) ? field.type : null;
}

/**
 * @param graph - the patched graph.
 * @param id - a field ID `<node>.<input>`; a node ID may itself hold a dot.
 * @returns the node and input it names where the node has that input as a literal; undefined for none.
 */
function literalInput(graph: ApiGraph, id: string): { node: string; input: string } | undefined {
  for (let at = id.indexOf("."); at !== -1; at = id.indexOf(".", at + 1)) {
    const node = id.slice(0, at);
    const input = id.slice(at + 1);
    // Own keys only: `constructor.x` must not reach a member of `Object.prototype`.
    if (!Object.hasOwn(graph, node)) continue;
    const inputs = graph[node]?.inputs;
    if (inputs !== undefined && Object.hasOwn(inputs, input) && isLiteral(inputs[input]))
      return { node, input };
  }
  return undefined;
}

/**
 * Check the params against the workflow and build the plan.
 * @param params - the params of the call.
 * @param workflow - the workflow the call names and its graph (the template).
 * @param mediaCount - the number of `media` inputs of the request.
 * @returns the plan.
 * @throws ProjectError `invalid_params` or `invalid_inputs` (one sentence) for every refusal that needs no server: a
 *   bad param, a patch that does not apply or makes a broken graph, a value for a field the workflow lacks or one
 *   that does not fit its type, a media field list that does not match the inputs.
 */
export function planRun(
  params: unknown,
  workflow: { item: WorkflowItem; graph: ApiGraph },
  mediaCount: number,
): GenPlan {
  const read = parseRunParams(params);
  if (mediaCount > GEN_LIMITS.mediaInputs) {
    throw new ProjectError(
      "invalid_inputs",
      `Give at most ${String(GEN_LIMITS.mediaInputs)} media inputs; got ${String(mediaCount)}.`,
    );
  }
  const { item } = workflow;

  // The patch: structural checks only; the server's node catalog is the entry's `validate`.
  let graph = workflow.graph;
  let fields = item.fields;
  let pinned: ReadonlySet<string> = new Set();
  if (read.ops !== undefined) {
    const { result, problems } = applyPatch(workflow.graph, parsePatch(read.ops));
    if (hasErrors(problems)) {
      throw new ProjectError(
        "invalid_params",
        `The patch makes a broken graph: ${problemLines(problems).join("; ")}.`,
      );
    }
    graph = result.graph;
    pinned = result.pinned;
    // A field the patch gave a value takes it as its default.
    fields = rebaseParams(result.graph, item.fields, pinned);
  } else {
    fields = rebaseParams(workflow.graph, item.fields, new Set());
  }
  const byId = new Map(fields.map((field) => [field.id, field]));

  // The values: each names a field of the patched workflow and fits its type.
  const values: Record<string, FieldValue> = {};
  for (const [id, raw] of Object.entries(read.values)) {
    const field = byId.get(id);
    if (field === undefined) {
      throw new ProjectError(
        "invalid_params",
        `The workflow has no field '${id}'${fieldHint(fields)}.`,
      );
    }
    if (isMediaParam(field.type)) {
      throw new ProjectError(
        "invalid_params",
        `Field '${id}' takes a ${field.type} asset, not a value: pass the asset in inputs.media and name the field in media_fields.`,
      );
    }
    values[id] = coerced(field, raw);
  }

  // The media fields: one per `media` input, each a literal input of the patched graph.
  if (read.mediaFields.length !== mediaCount) {
    throw new ProjectError(
      "invalid_params",
      mediaCount === 0
        ? "'media_fields' names fields, but the call has no media inputs. Pass the assets in inputs.media."
        : `Name the field each of the ${String(mediaCount)} media inputs fills in 'media_fields', in the same order; got ${String(read.mediaFields.length)}.`,
    );
  }
  const media: GenPlan["media"] = [];
  const seen = new Set<string>();
  for (const id of read.mediaFields) {
    if (seen.has(id)) {
      throw new ProjectError("invalid_params", `'media_fields' names '${id}' twice.`);
    }
    seen.add(id);
    const place = literalInput(graph, id);
    if (place === undefined) {
      throw new ProjectError(
        "invalid_params",
        `'${id}' in 'media_fields' is not a literal input of the graph (use <node>.<input>).`,
      );
    }
    const field = byId.get(id);
    const kind = mediaKindOf(field);
    if (kind === null && typeof graph[place.node]?.inputs[place.input] !== "string") {
      throw new ProjectError(
        "invalid_params",
        `'${id}' in 'media_fields' does not take a file name; pick a media field or a text input.`,
      );
    }
    if (Object.hasOwn(values, id)) {
      throw new ProjectError(
        "invalid_params",
        `'${id}' is in both 'values' and 'media_fields'; the asset fills it.`,
      );
    }
    media.push({ ...place, field: id, kind });
  }

  // The values go in; media fields keep the template's literals (the provider writes the uploaded names).
  let built: ApiGraph;
  try {
    built = applyParams(
      graph,
      fields.filter((field) => !isMediaParam(field.type)),
      values,
    );
  } catch (error) {
    if (!(error instanceof ParamValueError)) throw error;
    throw new ProjectError("invalid_params", `A field's default does not fit: ${error.message}`);
  }

  // The seeds: a seed field with a value or one the patch pinned keeps it for the first run.
  const seedFields = fields.filter((field) => field.type === "seed");
  const fixedSeeds: Record<string, number> = {};
  for (const field of seedFields) {
    const given = values[field.id];
    if (typeof given === "number") fixedSeeds[field.id] = given;
    else if (pinned.has(field.id) && typeof field.default === "number") {
      fixedSeeds[field.id] = field.default;
    }
  }

  return {
    graph: built,
    media,
    values,
    seedFields,
    fixedSeeds,
    count: read.count,
    label: read.label ?? item.name,
  };
}

/**
 * @param field - a field.
 * @param raw - a value a caller gave it.
 * @returns the value coerced to the field's type.
 * @throws ProjectError `invalid_params` naming the field when the value does not fit.
 */
function coerced(field: WorkflowParam, raw: FieldValue): FieldValue {
  try {
    return coerceParamValue(field, raw);
  } catch (error) {
    if (!(error instanceof ParamValueError)) throw error;
    throw new ProjectError("invalid_params", `Field '${field.id}': ${error.message}`);
  }
}

/**
 * @param fields - the workflow's fields.
 * @returns a clause that lists the field IDs for a refusal, or nothing when the workflow has none.
 */
function fieldHint(fields: WorkflowParam[]): string {
  if (fields.length === 0) return " (it exposes no fields)";
  const ids = fields.slice(0, 12).map((field) => field.id);
  return ` (fields: ${ids.join(", ")}${fields.length > ids.length ? ", ..." : ""})`;
}

/**
 * The graph of one run of the batch and the seeds it uses. A seed field with a value, or one the patch pinned, keeps
 * it for run 0 and draws anew for later runs; a seed field without one draws anew for every run.
 * @param plan - the plan.
 * @param index - the run's position in the batch, from 0.
 * @param random - draws one seed; `randomSeed` by default.
 * @returns a copy of the plan's graph with the seeds written in, and the seeds by field ID.
 */
/**
 * @param field - a seed field.
 * @param drawn - a drawn seed, a non-negative integer.
 * @returns the seed folded into the field's declared range (a node whose seed is 32 bits wide declares a `max`);
 *   the drawn seed itself where the field declares no range it falls outside of.
 */
function seedWithin(field: WorkflowParam, drawn: number): number {
  const min = Math.ceil(field.min ?? 0);
  const max = Math.floor(field.max ?? Number.MAX_SAFE_INTEGER);
  if (!(min <= max) || (drawn >= min && drawn <= max)) return drawn;
  return min + (drawn % (max - min + 1));
}

export function graphForRun(
  plan: GenPlan,
  index: number,
  random: () => number = randomSeed,
): { graph: ApiGraph; seeds: Record<string, number> } {
  const graph = structuredClone(plan.graph);
  const seeds: Record<string, number> = {};
  for (const field of plan.seedFields) {
    const fixed = plan.fixedSeeds[field.id];
    const seed = index === 0 && fixed !== undefined ? fixed : seedWithin(field, random());
    seeds[field.id] = seed;
    const node = graph[field.nodeId];
    if (node !== undefined) node.inputs[field.input] = seed;
  }
  return { graph, seeds };
}
