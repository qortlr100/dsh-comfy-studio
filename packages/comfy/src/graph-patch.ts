import { z } from "zod";
import { isModelLoaderInput } from "./model-loaders.ts";

/** True for a combo whose list ComfyUI's upload widgets manage (image, audio or video files). */
function isUploadInput(opts: Record<string, unknown> | undefined): boolean {
  return opts?.image_upload === true || opts?.audio_upload === true || opts?.video_upload === true;
}
import { familyWarnings } from "./family-checks.ts";
import { isLinkValue } from "./graph-diff.ts";
import type { FamilyResolver } from "./model-families.ts";
import {
  inputSpecOptions,
  inputSpecType,
  isLiteral,
  type ApiGraph,
  type ApiNode,
  type InputSpec,
  type NodeInfo,
  type ObjectInfo,
} from "./workflow.ts";

/**
 * Edits the agent makes to a template graph, as a list of operations applied in order to a
 * copy of the graph, and the checks that keep the result queueable. Pure logic, shared by the
 * tools, the runner and the proposal cards.
 *
 * Operations rather than a re-emitted graph: a model re-typing a 50KB graph costs tokens and
 * drops nodes; four small ops are cheap to emit and to validate. Links are written as
 * `{ node, output }` objects, not the API format's `[id, idx]` tuples, because tuples do not
 * survive the JSON Schema the model is given.
 */

const literalSchema = z.union([z.string().max(200_000), z.number(), z.boolean()]);
/** Node ids are strings in the API format; models sometimes write the numeric ones as numbers. */
const nodeRefSchema = z.union([z.string().min(1).max(100), z.number().int().nonnegative()]);
const inputNameSchema = z.string().min(1).max(100);
export const linkRefSchema = z.object({
  node: nodeRefSchema,
  /** Output slot index of the source node (0-based). */
  output: z.number().int().min(0).max(100),
});
export type LinkRef = z.infer<typeof linkRefSchema>;

export const graphPatchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    node: nodeRefSchema,
    input: inputNameSchema,
    value: literalSchema,
  }),
  z.object({
    op: z.literal("link"),
    node: nodeRefSchema,
    input: inputNameSchema,
    from: linkRefSchema,
  }),
  z.object({
    op: z.literal("add"),
    /** Omitted: the next free numeric id. */
    id: nodeRefSchema.optional(),
    class_type: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    inputs: z.record(inputNameSchema, z.union([literalSchema, linkRefSchema])).optional(),
  }),
  z.object({ op: z.literal("remove"), node: nodeRefSchema }),
]);
export type GraphPatchOp = z.infer<typeof graphPatchOpSchema>;

export const MAX_PATCH_OPS = 100;
export const graphPatchSchema = z.array(graphPatchOpSchema).min(1).max(MAX_PATCH_OPS);
export type GraphPatch = z.infer<typeof graphPatchSchema>;

/** An operation that cannot be applied to the graph as it stands (missing node, taken id). */
export class GraphPatchError extends Error {
  /** Index of the failing operation in the patch. */
  readonly opIndex: number;

  constructor(message: string, opIndex: number) {
    super(`연산 ${opIndex + 1}: ${message}`);
    this.opIndex = opIndex;
  }
}

export interface GraphPatchResult {
  graph: ApiGraph;
  /** Ids of nodes the patch created, in patch order. */
  added: string[];
  /** Ids of nodes the patch deleted, in patch order. */
  removed: string[];
  /**
   * Field ids (`node.input`) the patch gave a literal — by `set`, or as an input of a node it
   * added (also one that replaces a template node under the same id). Values the user asked
   * for: not re-rolled as seeds, not rebased over by a template field's stored default.
   */
  pinned: Set<string>;
}

/** Next free numeric node id: one past the largest numeric id in the graph (or 1). */
export function nextNodeId(graph: ApiGraph): string {
  let max = 0;
  for (const id of Object.keys(graph)) {
    const n = Number(id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return String(max + 1);
}

function toLink(ref: LinkRef): [string, number] {
  return [String(ref.node), ref.output];
}

/**
 * Applies the operations in order to a copy of `graph`. Throws `GraphPatchError` on the first
 * operation that has nothing to work on; whether the result is a valid graph (links resolve,
 * types agree, an output node remains) is `validateGraph`'s job, so a patch may link to a node
 * it adds later in the same list.
 */
export function applyGraphPatch(graph: ApiGraph, ops: GraphPatch): GraphPatchResult {
  const out: ApiGraph = structuredClone(graph);
  const added: string[] = [];
  const removed: string[] = [];
  const pinned = new Set<string>();
  ops.forEach((op, i) => {
    switch (op.op) {
      case "set":
      case "link": {
        const id = String(op.node);
        const node = out[id];
        if (!node) throw new GraphPatchError(`노드 ${id}가 없습니다`, i);
        node.inputs[op.input] = op.op === "set" ? op.value : toLink(op.from);
        if (op.op === "set") pinned.add(`${id}.${op.input}`);
        else pinned.delete(`${id}.${op.input}`);
        break;
      }
      case "add": {
        const id = op.id === undefined ? nextNodeId(out) : String(op.id);
        if (out[id]) throw new GraphPatchError(`노드 id ${id}는 이미 있습니다`, i);
        const inputs: Record<string, unknown> = {};
        for (const [name, v] of Object.entries(op.inputs ?? {})) {
          inputs[name] = isLiteral(v) ? v : toLink(v);
          if (isLiteral(v)) pinned.add(`${id}.${name}`);
        }
        const node: ApiNode = { class_type: op.class_type, inputs };
        if (op.title) node._meta = { title: op.title };
        out[id] = node;
        added.push(id);
        break;
      }
      case "remove": {
        const id = String(op.node);
        if (!out[id]) throw new GraphPatchError(`노드 ${id}가 없습니다`, i);
        delete out[id];
        for (const key of pinned) if (key.startsWith(`${id}.`)) pinned.delete(key);
        // Added earlier in this same patch: it never existed for the template, so it is neither
        // added (no strict check, no proposal row) nor removed.
        const addedAt = added.indexOf(id);
        if (addedAt >= 0) added.splice(addedAt, 1);
        else removed.push(id);
        break;
      }
    }
  });
  return { graph: out, added, removed, pinned };
}

/** One thing wrong with a graph. Warnings do not stop a run; errors do. */
export interface GraphProblem {
  nodeId: string;
  input?: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidateGraphOptions {
  /**
   * Nodes whose `required` inputs must all be present (the ones a patch added). Template nodes
   * are not held to this: a snapshot from another server may list inputs the template never
   * had, and ComfyUI's own check runs at queue time anyway.
   */
  strictNodes?: Iterable<string>;
  /** Looks up the family rules of a model file a loader names; adds family warnings when given. */
  familyOf?: FamilyResolver;
}

/**
 * Output node classes assumed when no catalog says which classes are `output_node`. Only used
 * for the "graph still has an output" check without server information.
 */
const KNOWN_OUTPUT_CLASSES = new Set([
  "SaveImage",
  "PreviewImage",
  "SaveAnimatedWEBP",
  "SaveAnimatedPNG",
  "SaveAudio",
  "SaveAudioMP3",
  "SaveAudioOpus",
  "PreviewAudio",
  "SaveVideo",
  "SaveWEBM",
  "SaveGLB",
  "SaveLatent",
  "VHS_VideoCombine",
]);

function specOf(info: NodeInfo, input: string): InputSpec | undefined {
  const spec = info.input?.required?.[input] ?? info.input?.optional?.[input];
  return Array.isArray(spec) ? spec : undefined;
}

function show(v: unknown): string {
  const s = typeof v === "string" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** Whether a literal fits the typed input; a message when it does not. */
function literalProblem(spec: InputSpec, value: string | number | boolean): string | null {
  const type = inputSpecType(spec);
  const opts = spec[1] ?? {};
  switch (type) {
    case "INT":
    case "FLOAT": {
      if (typeof value !== "number") return `숫자여야 합니다 (받은 값 ${show(value)})`;
      if (type === "INT" && !Number.isInteger(value)) return `정수여야 합니다 (받은 값 ${value})`;
      if (typeof opts.min === "number" && value < opts.min) return `${opts.min} 이상이어야 합니다`;
      if (typeof opts.max === "number" && value > opts.max) return `${opts.max} 이하여야 합니다`;
      return null;
    }
    case "BOOLEAN":
      return typeof value === "boolean" ? null : `true/false여야 합니다 (받은 값 ${show(value)})`;
    case "STRING":
      return typeof value === "string" ? null : `문자열이어야 합니다 (받은 값 ${show(value)})`;
    case "COMBO":
      return typeof value === "string" ? null : `선택지 이름(문자열)이어야 합니다`;
    case "*":
      return null;
    default:
      return `${type} 타입 입력은 링크로 연결해야 합니다 (리터럴 ${show(value)})`;
  }
}

/**
 * Checks that a graph can be queued: every link points at an existing node, and (with a
 * catalog) every class exists, every input is one the class declares and fits its type, every
 * link carries a matching output type, strict nodes have their required inputs, and an output
 * node remains. Without a catalog only the structural checks run.
 */
export function validateGraph(
  graph: ApiGraph,
  catalog?: ObjectInfo,
  opts: ValidateGraphOptions = {},
): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const error = (nodeId: string, message: string, input?: string) =>
    problems.push({ nodeId, ...(input ? { input } : {}), message, severity: "error" });
  const warn = (nodeId: string, message: string, input: string) =>
    problems.push({ nodeId, input, message, severity: "warning" });
  const strict = new Set(opts.strictNodes ?? []);

  for (const [nodeId, node] of Object.entries(graph)) {
    const info = catalog?.[node.class_type];
    if (catalog && !info) {
      error(nodeId, `서버에 없는 노드 클래스입니다: ${node.class_type}`);
      continue;
    }
    for (const [input, value] of Object.entries(node.inputs)) {
      const spec = info ? specOf(info, input) : undefined;
      // Some classes take inputs the catalog does not list (dynamic inputs such as `values.a`,
      // format-dependent options). ComfyUI ignores or checks them at queue time; only warn.
      if (info && !spec)
        warn(nodeId, `${node.class_type}가 선언하지 않은 입력입니다 (서버가 확인합니다)`, input);
      if (isLinkValue(value)) {
        const [srcId, idx] = value;
        // Own keys only, so a link to "constructor" is the missing node it is.
        const src = Object.hasOwn(graph, srcId) ? graph[srcId] : undefined;
        if (!src) {
          error(nodeId, `링크 대상 노드 ${srcId}가 없습니다`, input);
          continue;
        }
        const srcInfo = catalog?.[src.class_type];
        if (!spec || !srcInfo?.output) continue;
        if (idx >= srcInfo.output.length) {
          error(
            nodeId,
            `${src.class_type}(노드 ${srcId})에는 출력 ${idx}가 없습니다 (출력 ${srcInfo.output.length}개)`,
            input,
          );
          continue;
        }
        const want = inputSpecType(spec);
        const got = srcInfo.output[idx];
        if (typeof got !== "string" || want === "*" || got === "*" || want === "COMBO") continue;
        if (want !== got)
          error(
            nodeId,
            `${input}은 ${want} 입력인데 노드 ${srcId} 출력 ${idx}는 ${got}입니다`,
            input,
          );
        continue;
      }
      if (!isLiteral(value)) {
        error(nodeId, `값이 리터럴도 링크도 아닙니다: ${show(JSON.stringify(value))}`, input);
        continue;
      }
      if (!spec) continue;
      const bad = literalProblem(spec, value);
      if (bad) {
        error(nodeId, bad, input);
        continue;
      }
      const options = inputSpecOptions(spec);
      if (options && !options.includes(String(value))) {
        const msg = `선택지에 없는 값입니다: ${show(value)}`;
        // Model lists are incomplete on some servers (Cloud BYOM) and the input file lists are
        // snapshots a later upload outdates (the catalog is cached); ComfyUI decides at queue time.
        if (isModelLoaderInput(node.class_type, input) || isUploadInput(spec[1]))
          warn(nodeId, msg, input);
        else error(nodeId, msg, input);
      }
    }
    if (info && strict.has(nodeId)) {
      for (const input of Object.keys(info.input?.required ?? {}))
        if (!(input in node.inputs))
          error(nodeId, `${node.class_type}의 필수 입력이 비었습니다`, input);
    }
  }

  const hasOutput = Object.values(graph).some((n) =>
    catalog ? catalog[n.class_type]?.output_node === true : KNOWN_OUTPUT_CLASSES.has(n.class_type),
  );
  if (!hasOutput)
    problems.push({
      nodeId: "",
      message: "출력 노드(SaveImage 등)가 없어 실행할 수 없습니다",
      severity: "error",
    });
  if (opts.familyOf) problems.push(...familyWarnings(graph, opts.familyOf));
  return problems;
}

/**
 * Problems a patch introduced: `validateGraph(patched)` minus what the template already had
 * (same node, input and message). A template that the catalog cannot fully describe (another
 * server's snapshot, custom nodes with dynamic inputs) must not stop edits that leave those
 * nodes as they were.
 */
export function newProblems(
  template: ApiGraph,
  patched: ApiGraph,
  catalog?: ObjectInfo,
  opts: ValidateGraphOptions = {},
): GraphProblem[] {
  const key = (p: GraphProblem) => `${p.nodeId}\u0000${p.input ?? ""}\u0000${p.message}`;
  const before = new Set(
    validateGraph(template, catalog, opts.familyOf ? { familyOf: opts.familyOf } : {}).map(key),
  );
  return validateGraph(patched, catalog, opts).filter((p) => !before.has(key(p)));
}

/** Problems as one line each, for a tool result or an HTTP 400. */
export function formatProblems(problems: GraphProblem[]): string {
  return problems
    .map((p) => {
      const where = p.nodeId ? `노드 ${p.nodeId}${p.input ? `.${p.input}` : ""}: ` : "";
      return `${p.severity === "warning" ? "(경고) " : ""}${where}${p.message}`;
    })
    .join("\n");
}

export function hasErrors(problems: GraphProblem[]): boolean {
  return problems.some((p) => p.severity === "error");
}
