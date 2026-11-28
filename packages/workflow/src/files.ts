/**
 * The pure logic of the workflow component that works on files, graphs and fields: reading an uploaded file, the
 * canonical bytes of a graph, the exposed fields (suggested, checked, trimmed), and applying a graph patch. Nothing
 * here touches Cordis or the filesystem. The design is `docs/archive/PLAN_2-3c.md`.
 *
 * The graph and field logic is the ComfyUI library's (`@cs/comfy`); this module adds the limits, the canonical form and
 * the `ProjectError` sentences the operations show. The sentences of the library (patch errors, graph problems) are
 * Korean and pass through unchanged.
 *
 * @module @cs/workflow/files
 */
import { graphFromPng } from "@cs/comfy/embedded-graph";
import { compareNodeIds } from "@cs/comfy/graph-diff";
import {
  applyGraphPatch,
  GraphPatchError,
  graphPatchSchema,
  newProblems,
  type GraphPatch,
  type GraphPatchResult,
  type GraphProblem,
} from "@cs/comfy/graph-patch";
import {
  coerceParamValue,
  isLiteral,
  listInputCandidates,
  parseApiGraph,
  ParamValueError,
  rebaseParams,
  suggestParams,
  workflowParamSchema,
  type ApiGraph,
  type ObjectInfo,
  type WorkflowParam,
} from "@cs/comfy/workflow";
import { ProjectError } from "@cs/project";
import { WORKFLOW_LIMITS } from "./types.ts";

/** The refusal of a file whose JSON cannot be handled (too deeply nested, say). */
const UNREADABLE_GRAPH = "The file is not a graph this app can read.";

/** A graph read from an uploaded file. */
export interface ParsedGraphFile {
  graph: ApiGraph;
  /** The canonical JSON bytes. */
  bytes: Uint8Array;
  /** The number of nodes. */
  nodes: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * @param text - some text.
 * @returns the number of characters (code points) of the text.
 */
function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * @param text - some text.
 * @param max - the most characters to keep.
 * @returns the text cut to `max` characters (code points).
 */
function cutChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/**
 * @param text - some text.
 * @param max - the most characters the result may have, the ellipsis included.
 * @returns the text, or its beginning followed by `…` when it is longer than `max`.
 */
export function ellipsize(text: string, max: number): string {
  return charCount(text) <= max ? text : `${cutChars(text, max - 1)}…`;
}

/**
 * @param bytes - a file.
 * @returns whether it starts with the PNG signature.
 */
function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)
  );
}

/**
 * @param value - a parsed JSON value.
 * @returns a copy with the keys of every object sorted, so equal values give equal text.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    // `Object.fromEntries` defines own properties, so a key named `__proto__` stays a key.
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

/**
 * @param graph - an API-format graph.
 * @returns the canonical JSON bytes of the graph: nodes in `compareNodeIds` order, every object's keys sorted,
 *   2-space indent, UTF-8. The same graph always gives the same bytes, so the asset store keeps it once.
 */
export function canonicalGraph(graph: ApiGraph): Uint8Array {
  try {
    return canonicalBytes(graph);
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    // Absurdly nested values overflow the stack of the recursive walk and of `JSON.stringify`.
    throw new ProjectError("invalid_inputs", UNREADABLE_GRAPH);
  }
}

/**
 * @param graph - an API-format graph.
 * @returns the canonical bytes; may throw a `RangeError` for a value nested too deeply.
 */
function canonicalBytes(graph: ApiGraph): Uint8Array {
  const ordered = Object.fromEntries(
    Object.keys(graph)
      .toSorted(compareNodeIds)
      .map((id) => [id, graph[id]]),
  );
  return new TextEncoder().encode(JSON.stringify(sortKeys(ordered), null, 2));
}

/**
 * @param error - a thrown value.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Read an uploaded workflow file: API-format JSON, or a PNG that ComfyUI wrote (its `prompt` chunk). A PNG is
 * detected by its signature, not by `mime`.
 * @param bytes - the file.
 * @param _mime - the file's media type; unused, the content decides.
 * @returns the graph with its canonical bytes.
 * @throws ProjectError `invalid_inputs` for a file over the size limit, text that is not JSON, UI-format JSON, a PNG
 *   without a graph, or a graph that is not API format.
 */
export function parseGraphFile(bytes: Uint8Array, _mime: string): ParsedGraphFile {
  try {
    return parseGraphFileUnsafe(bytes);
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError("invalid_inputs", UNREADABLE_GRAPH);
  }
}

/**
 * @param bytes - the file.
 * @returns the graph with its canonical bytes; the throws of `parseGraphFile`, and any other error for input the
 *   recursive walks cannot handle.
 */
function parseGraphFileUnsafe(bytes: Uint8Array): ParsedGraphFile {
  if (bytes.length > WORKFLOW_LIMITS.fileBytes) {
    const mib = WORKFLOW_LIMITS.fileBytes / (1024 * 1024);
    throw new ProjectError("invalid_inputs", `The workflow file is over the limit of ${mib} MiB.`);
  }
  let graph: ApiGraph;
  if (isPng(bytes)) {
    const found = graphFromPng(bytes);
    if (found.graph === null) throw new ProjectError("invalid_inputs", found.error);
    graph = found.graph;
  } else {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ProjectError(
        "invalid_inputs",
        "The file is neither a JSON workflow nor a PNG that ComfyUI wrote.",
      );
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "nodes" in value &&
      "links" in value &&
      Array.isArray(value.nodes) &&
      Array.isArray(value.links)
    ) {
      throw new ProjectError(
        "invalid_inputs",
        "This is a UI-format workflow. Export it in API format from ComfyUI ('Export (API)' or 'Save (API Format)') and upload that file.",
      );
    }
    try {
      graph = parseApiGraph(value);
    } catch (error) {
      throw new ProjectError("invalid_inputs", messageOf(error));
    }
  }
  return { graph, bytes: canonicalGraph(graph), nodes: Object.keys(graph).length };
}

/**
 * @param bytes - a stored canonical graph blob.
 * @returns the graph.
 * @throws ProjectError `invalid_inputs` when the bytes are not an API-format graph.
 */
export function readGraph(bytes: Uint8Array): ApiGraph {
  try {
    return parseApiGraph(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    throw new ProjectError(
      "invalid_inputs",
      `The stored workflow graph cannot be read: ${messageOf(error)}`,
    );
  }
}

/** The limits `workflowParamSchema` puts on the text of a field, read from the schema. */
const FIELD_TEXT = {
  label: workflowParamSchema.shape.label.maxLength ?? 100,
  option: workflowParamSchema.shape.options.unwrap().element.maxLength ?? 1000,
} as const;

/**
 * @param field - a field.
 * @returns whether the field parses with `workflowParamSchema`, the form the reducer accepts.
 */
function fitsSchema(field: WorkflowParam): boolean {
  return workflowParamSchema.safeParse(field).success;
}

/**
 * @param field - a field.
 * @returns the field as stored: only the known keys; the label cut to the schema's limit; no `options` when there are
 *   more than `WORKFLOW_LIMITS.fieldOptions` or any is longer than the schema allows (a server's model list does not
 *   belong in a record); no `min`, `max` or `step` the schema refuses. A field that still does not parse (a default
 *   over the limit, say) stays as it is: callers drop it with `fitsSchema`.
 */
export function trimField(field: WorkflowParam): WorkflowParam {
  const out: WorkflowParam = {
    id: field.id,
    nodeId: field.nodeId,
    input: field.input,
    label: ellipsize(field.label.trim(), FIELD_TEXT.label),
    type: field.type,
    default: field.default,
  };
  if (field.multiline !== undefined) out.multiline = field.multiline;
  if (field.min !== undefined && Number.isFinite(field.min)) out.min = field.min;
  if (field.max !== undefined && Number.isFinite(field.max)) out.max = field.max;
  if (field.step !== undefined && Number.isFinite(field.step) && field.step > 0) {
    out.step = field.step;
  }
  if (
    field.options !== undefined &&
    field.options.length <= WORKFLOW_LIMITS.fieldOptions &&
    field.options.every((option) => option.length <= FIELD_TEXT.option)
  ) {
    out.options = field.options;
  }
  return out;
}

/**
 * @param graph - a graph.
 * @param objectInfo - a server's node catalog, when one answered.
 * @returns the default fields of a new workflow, trimmed, at most `WORKFLOW_LIMITS.fields`; a field that cannot be
 *   stored even trimmed is left out.
 */
export function suggestedFields(graph: ApiGraph, objectInfo?: ObjectInfo): WorkflowParam[] {
  return suggestParams(listInputCandidates(graph, objectInfo))
    .map(trimField)
    .filter(fitsSchema)
    .slice(0, WORKFLOW_LIMITS.fields);
}

/**
 * Check fields a user edited.
 * @param graph - the graph the fields bind to.
 * @param fields - the fields as the caller gave them.
 * @returns the fields trimmed, with each default coerced to its type.
 * @throws ProjectError `invalid_params` naming the field when it does not parse, does not bind to a literal input
 *   of the graph, repeats an ID, has a default that does not fit its type, or when there are too many fields.
 */
export function checkFields(graph: ApiGraph, fields: unknown): WorkflowParam[] {
  if (!Array.isArray(fields))
    throw new ProjectError("invalid_params", "'fields' must be an array.");
  if (fields.length > WORKFLOW_LIMITS.fields) {
    throw new ProjectError(
      "invalid_params",
      `A workflow exposes at most ${WORKFLOW_LIMITS.fields} fields; got ${fields.length}.`,
    );
  }
  const seen = new Set<string>();
  const out: WorkflowParam[] = [];
  fields.forEach((raw: unknown, index) => {
    const parsed = workflowParamSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where =
        issue === undefined || issue.path.length === 0 ? "" : ` ${issue.path.join(".")}`;
      throw new ProjectError(
        "invalid_params",
        `Field ${index + 1}${where}: ${issue?.message ?? "is not a valid field"}.`,
      );
    }
    const field = parsed.data;
    const named = `Field '${field.id}'`;
    if (field.id !== `${field.nodeId}.${field.input}`) {
      throw new ProjectError("invalid_params", `${named}: its id must be '<nodeId>.<input>'.`);
    }
    if (seen.has(field.id)) throw new ProjectError("invalid_params", `${named} appears twice.`);
    seen.add(field.id);
    const node = Object.hasOwn(graph, field.nodeId) ? graph[field.nodeId] : undefined;
    const bound =
      node !== undefined &&
      Object.hasOwn(node.inputs, field.input) &&
      isLiteral(node.inputs[field.input]);
    if (!bound) {
      throw new ProjectError(
        "invalid_params",
        `${named} is not bound: node ${field.nodeId} has no literal input '${field.input}'.`,
      );
    }
    if (field.options !== undefined && field.options.length > WORKFLOW_LIMITS.fieldOptions) {
      throw new ProjectError(
        "invalid_params",
        `${named} has ${field.options.length} choices; leave 'options' out (at most ${WORKFLOW_LIMITS.fieldOptions} are kept): the form reads the choices from the server.`,
      );
    }
    if (
      typeof field.default === "string" &&
      field.default.length > WORKFLOW_LIMITS.fieldDefaultChars
    ) {
      throw new ProjectError(
        "invalid_params",
        `${named}: its default is over ${WORKFLOW_LIMITS.fieldDefaultChars} characters.`,
      );
    }
    try {
      const stored = trimField({ ...field, default: coerceParamValue(field, field.default) });
      if (!fitsSchema(stored)) {
        throw new ProjectError("invalid_params", `${named} cannot be stored as it is given.`);
      }
      out.push(stored);
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      if (!(error instanceof ParamValueError)) throw error;
      throw new ProjectError(
        "invalid_params",
        `${named}: its default does not fit: ${error.message}`,
      );
    }
  });
  return out;
}

/**
 * @param fileName - the name of an uploaded file.
 * @returns the name a workflow gets from it: without its directories and its last extension, trimmed, cut to
 *   `WORKFLOW_LIMITS.nameChars`; "workflow" when nothing is left.
 */
export function nameFromFile(fileName: string): string {
  const base = fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  const stem = (dot >= 0 ? base.slice(0, dot) : base).trim();
  const name = cutChars(stem, WORKFLOW_LIMITS.nameChars).trim();
  return name === "" ? "workflow" : name;
}

/**
 * @param name - a name as a caller gave it.
 * @returns the name trimmed.
 * @throws ProjectError `invalid_params` unless it is text of 1 to `WORKFLOW_LIMITS.nameChars` characters.
 */
export function checkName(name: unknown): string {
  if (typeof name !== "string")
    throw new ProjectError("invalid_params", "'name' must be a string.");
  const trimmed = name.trim();
  const length = charCount(trimmed);
  if (length < 1 || length > WORKFLOW_LIMITS.nameChars) {
    throw new ProjectError(
      "invalid_params",
      `'name' must have 1 to ${WORKFLOW_LIMITS.nameChars} characters.`,
    );
  }
  return trimmed;
}

/**
 * @param description - a description as a caller gave it; undefined for none.
 * @returns the description trimmed; empty text for none.
 * @throws ProjectError `invalid_params` for a non-string or one over `WORKFLOW_LIMITS.descriptionChars`.
 */
export function checkDescription(description: unknown): string {
  if (description === undefined) return "";
  if (typeof description !== "string") {
    throw new ProjectError("invalid_params", "'description' must be a string.");
  }
  const trimmed = description.trim();
  if (charCount(trimmed) > WORKFLOW_LIMITS.descriptionChars) {
    throw new ProjectError(
      "invalid_params",
      `'description' must have at most ${WORKFLOW_LIMITS.descriptionChars} characters.`,
    );
  }
  return trimmed;
}

/**
 * @param ops - patch operations as a caller gave them.
 * @returns the patch.
 * @throws ProjectError `invalid_params` with the first issue and where it is.
 */
export function parsePatch(ops: unknown): GraphPatch {
  const parsed = graphPatchSchema.safeParse(ops);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where =
    issue === undefined || issue.path.length === 0 ? "ops" : `ops.${issue.path.join(".")}`;
  throw new ProjectError(
    "invalid_params",
    `Invalid patch at ${where}: ${issue?.message ?? "invalid"}.`,
  );
}

/**
 * Refuse an operation on a node named like a member of `Object.prototype` (`constructor`, `toString`, `__proto__`) when
 * the graph has no such node: the library's plain lookup would find the inherited member and throw a `TypeError`.
 * @param template - the graph to patch.
 * @param ops - the patch.
 * @throws ProjectError `invalid_params` as `op <n>: …` for an operation that needs a node the graph does not have.
 */
function requireOwnNodes(template: ApiGraph, ops: GraphPatch): void {
  const names = new Set(Object.keys(template));
  ops.forEach((op, index) => {
    if (op.op === "add") {
      if (op.id !== undefined) names.add(String(op.id));
      return;
    }
    const id = String(op.node);
    if (Object.hasOwn(Object.prototype, id) && !names.has(id)) {
      throw new ProjectError("invalid_params", `op ${index + 1}: node ${id} does not exist.`);
    }
    if (op.op === "remove") names.delete(id);
  });
}

/** What applying a patch to a template gives. */
export interface PatchOutcome {
  result: GraphPatchResult;
  /** The problems the patch made that the template did not have (`newProblems`; the added nodes are held strictly). */
  problems: GraphProblem[];
}

/**
 * Apply a patch and check the result.
 * @param template - the graph to patch; it is not changed.
 * @param ops - the patch.
 * @param objectInfo - a server's node catalog, when one answered; without it only the structure is checked.
 * @returns the patched graph and the problems the patch made.
 * @throws ProjectError `invalid_params` as `op <n>: <reason>` (n counts from 1) when an operation does not apply.
 */
export function applyPatch(
  template: ApiGraph,
  ops: GraphPatch,
  objectInfo?: ObjectInfo,
): PatchOutcome {
  requireOwnNodes(template, ops);
  let result: GraphPatchResult;
  try {
    result = applyGraphPatch(template, ops);
  } catch (error) {
    if (!(error instanceof GraphPatchError)) {
      // The library only throws `GraphPatchError` for what it checked; anything else is input it did not expect.
      throw new ProjectError("invalid_params", "op ?: The patch could not be applied.");
    }
    // The library's message starts with its own "연산 <n>: "; the number is said once, in English.
    const reason = error.message.replace(/^연산 \d+: /, "");
    throw new ProjectError("invalid_params", `op ${error.opIndex + 1}: ${reason}`);
  }
  // Checked here and not left to `newProblems`: that only lists what the template did not have already, and a graph
  // without nodes cannot be stored or read back at all.
  if (Object.keys(result.graph).length === 0) {
    throw new ProjectError("invalid_params", "The patch leaves no node in the graph.");
  }
  const problems = newProblems(template, result.graph, objectInfo, { strictNodes: result.added });
  return { result, problems };
}

/**
 * @param parentFields - the fields of the workflow the variant comes from.
 * @param result - the patch result.
 * @param objectInfo - a server's node catalog, when one answered.
 * @returns the fields of the variant: the parent's fields that still bind (a field the patch gave a value takes it as
 *   its default), then the suggested fields of the nodes the patch added, trimmed, at most `WORKFLOW_LIMITS.fields`;
 *   a field that cannot be stored even trimmed is left out.
 */
export function variantFields(
  parentFields: WorkflowParam[],
  result: GraphPatchResult,
  objectInfo?: ObjectInfo,
): WorkflowParam[] {
  const kept = rebaseParams(result.graph, parentFields, result.pinned);
  const have = new Set(kept.map((field) => field.id));
  const added = new Set(result.added);
  const fresh = suggestParams(
    listInputCandidates(result.graph, objectInfo).filter((candidate) =>
      added.has(candidate.nodeId),
    ),
  ).filter((field) => !have.has(field.id));
  return [...kept, ...fresh].map(trimField).filter(fitsSchema).slice(0, WORKFLOW_LIMITS.fields);
}

/**
 * Check the values a patch pinned into the parent's fields: a variant must not store a default its field does not
 * take (a seed of -1, a number in a text field).
 * @param parentFields - the fields of the workflow the variant comes from.
 * @param result - the patch result.
 * @throws ProjectError `invalid_params` naming the first field whose pinned value does not fit it.
 */
export function checkPinnedDefaults(parentFields: WorkflowParam[], result: GraphPatchResult): void {
  for (const field of rebaseParams(result.graph, parentFields, result.pinned)) {
    if (!result.pinned.has(field.id)) continue;
    try {
      coerceParamValue(field, field.default);
    } catch (error) {
      if (!(error instanceof ParamValueError)) throw error;
      throw new ProjectError(
        "invalid_params",
        `The patch sets field '${field.id}' to a value it does not take: ${error.message}`,
      );
    }
  }
}

/**
 * @param problems - the problems of a graph check.
 * @returns one sentence per problem: `node <id>[.<input>]: <message>`; a problem of the whole graph is its message;
 *   warnings are prefixed `(warning) `.
 */
export function problemLines(problems: GraphProblem[]): string[] {
  return problems.map((problem) => {
    const where =
      problem.nodeId === ""
        ? ""
        : `node ${problem.nodeId}${problem.input === undefined ? "" : `.${problem.input}`}: `;
    return `${problem.severity === "warning" ? "(warning) " : ""}${where}${problem.message}`;
  });
}
