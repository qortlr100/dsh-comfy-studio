import { z } from "zod";

/**
 * ComfyUI "API format" workflows (Save (API Format) in the ComfyUI menu) and the form fields
 * ComfyStudio exposes on top of them. Pure logic, shared by the server and the browser.
 *
 * An API graph maps node ids to `{ class_type, inputs }`. An input is either a literal value
 * (string/number/boolean) or a link `[sourceNodeId, outputIndex]`. Only literals can become
 * form fields.
 */

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ApiGraph = Record<string, ApiNode>;

export const PARAM_TYPES = [
  "text",
  "integer",
  "number",
  "boolean",
  "select",
  "seed",
  "image",
  "audio",
  "video",
] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/**
 * Field types whose value names a file in the server's input folder (LoadImage, LoadAudio,
 * LoadVideo and the like): uploaded per server, fed from assets by the agent, never a value
 * to type in.
 */
export const MEDIA_PARAM_TYPES = ["image", "audio", "video"] as const;
export type MediaParamType = (typeof MEDIA_PARAM_TYPES)[number];
export function isMediaParam(type: ParamType): type is MediaParamType {
  return (MEDIA_PARAM_TYPES as readonly string[]).includes(type);
}

/** One form field bound to `graph[nodeId].inputs[input]`. */
export interface WorkflowParam {
  /** Stable key for form values: `${nodeId}.${input}`. */
  id: string;
  nodeId: string;
  input: string;
  label: string;
  type: ParamType;
  default: string | number | boolean;
  /** Multi-line text box (prompts). */
  multiline?: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Choices for `select` (and known input files for `image`). */
  options?: string[];
}

/** A literal input that could be exposed, with what ComfyUI says about it (if known). */
export interface InputCandidate {
  nodeId: string;
  classType: string;
  nodeTitle: string;
  input: string;
  value: string | number | boolean;
  /** Field definition inferred from `/object_info` (or from the value alone). */
  param: WorkflowParam;
}

export class WorkflowFormatError extends Error {}

const nodeSchema = z.object({
  class_type: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()),
  _meta: z.object({ title: z.string().optional() }).passthrough().optional(),
});

/** Largest seed we generate; ComfyUI accepts up to 2^64-1 but JSON numbers lose precision. */
export const MAX_SEED = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validates an uploaded JSON value as an API-format graph. The UI-format export
 * (`{ nodes: [...], links: [...] }`) is rejected with a hint, since it cannot be queued.
 */
export function parseApiGraph(value: unknown): ApiGraph {
  if (!isRecord(value) || Array.isArray(value))
    throw new WorkflowFormatError("워크플로 JSON은 객체여야 합니다");
  const obj = value;
  if (Array.isArray(obj.nodes) && Array.isArray(obj.links)) {
    throw new WorkflowFormatError(
      "UI 형식 워크플로입니다. ComfyUI에서 'Export (API)' / 'Save (API Format)'으로 내보낸 JSON을 올려 주세요",
    );
  }
  // Some exports wrap the graph: { prompt: {...} }.
  const graph = isRecord(obj.prompt) && !Array.isArray(obj.prompt) ? obj.prompt : obj;
  const out: ApiGraph = {};
  for (const [id, node] of Object.entries(graph)) {
    const parsed = nodeSchema.safeParse(node);
    if (!parsed.success)
      throw new WorkflowFormatError(`노드 ${id}에 class_type/inputs가 없습니다 (API 형식이 아님)`);
    out[id] = parsed.data;
  }
  if (Object.keys(out).length === 0) throw new WorkflowFormatError("노드가 없는 워크플로입니다");
  return out;
}

/** A literal input value, as opposed to a link `[sourceNodeId, outputIndex]`. */
export function isLiteral(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** `/object_info` input spec: `[type, options?]`, where type is a string or a legacy combo list. */
export type InputSpec = [unknown, Record<string, unknown>?];

/** `/object_info` entry for one node class (only the parts we read). */
export interface NodeInfo {
  input?: {
    required?: Record<string, InputSpec>;
    optional?: Record<string, InputSpec>;
  };
  display_name?: string;
  description?: string;
  /** Menu path such as `loaders` or `image/upscaling`. */
  category?: string;
  /** Output slot types by index (`"MODEL"`, `"LATENT"`, …; `"*"` matches any input). */
  output?: unknown[];
  output_name?: string[];
  /** Ends a graph (SaveImage, PreviewImage, …); ComfyUI refuses a prompt without one. */
  output_node?: boolean;
}
export type ObjectInfo = Record<string, NodeInfo>;

function specFor(info: NodeInfo | undefined, input: string): InputSpec | undefined {
  const spec = info?.input?.required?.[input] ?? info?.input?.optional?.[input];
  return Array.isArray(spec) ? spec : undefined;
}

/** A whole `/object_info` body as a catalog; entries that are not objects are dropped. */
export function parseObjectInfo(body: unknown): ObjectInfo {
  const out: ObjectInfo = {};
  if (!isRecord(body) || Array.isArray(body)) return out;
  for (const [classType, info] of Object.entries(body))
    if (info && typeof info === "object" && !Array.isArray(info)) out[classType] = info;
  return out;
}

/**
 * The type name of an input spec: `"INT"`, `"MODEL"`, … for typed inputs, `"COMBO"` for a
 * choice list (legacy array form or `"COMBO"`), `"*"` when the spec says nothing usable.
 */
export function inputSpecType(spec: InputSpec): string {
  const [kind] = spec;
  if (Array.isArray(kind)) return "COMBO";
  return typeof kind === "string" ? kind : "*";
}

/** The choices of a COMBO spec in either form, or undefined for other inputs. */
export function inputSpecOptions(spec: InputSpec): string[] | undefined {
  const [kind, opts] = spec;
  const list = Array.isArray(kind) ? kind : kind === "COMBO" ? opts?.options : undefined;
  return Array.isArray(list) ? list.map(String) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter(
    (x): x is string | number => typeof x === "string" || typeof x === "number",
  );
  return list.map(String);
}

const SEED_INPUTS = new Set(["seed", "noise_seed"]);

/** Turns a node input name into a readable default label. */
function humanize(input: string): string {
  return input.replace(/_/g, " ");
}

/**
 * Field definition for one literal input. Prefers the node's `/object_info` spec; without it,
 * the type is guessed from the current value.
 */
export function inferParam(
  nodeId: string,
  node: ApiNode,
  input: string,
  value: string | number | boolean,
  info?: NodeInfo,
): WorkflowParam {
  const title = node._meta?.title || info?.display_name || node.class_type;
  const base = { id: `${nodeId}.${input}`, nodeId, input, label: `${title} · ${humanize(input)}` };
  const spec = specFor(info, input);
  const [kind, opts = {}] = spec ?? [];

  const comboOptions = Array.isArray(kind)
    ? strings(kind)
    : kind === "COMBO"
      ? strings(opts.options)
      : undefined;
  if (comboOptions) {
    // ComfyUI marks the file lists its upload widgets manage (LoadImage, LoadAudio, LoadVideo).
    const media =
      opts.image_upload === true
        ? "image"
        : opts.audio_upload === true
          ? "audio"
          : opts.video_upload === true
            ? "video"
            : null;
    if (media) return { ...base, type: media, default: String(value), options: comboOptions };
    return { ...base, type: "select", default: String(value), options: comboOptions };
  }

  const range = { min: num(opts.min), max: num(opts.max), step: num(opts.step) };
  const isSeed = SEED_INPUTS.has(input) || Boolean(opts.control_after_generate);
  if (kind === "INT" || (!spec && typeof value === "number" && Number.isInteger(value))) {
    if (isSeed && typeof value === "number")
      return { ...base, type: "seed", default: value, min: 0, max: MAX_SEED };
    return { ...base, type: "integer", default: Number(value) || 0, ...range };
  }
  if (kind === "FLOAT" || (!spec && typeof value === "number")) {
    return { ...base, type: "number", default: Number(value) || 0, ...range };
  }
  if (kind === "BOOLEAN" || typeof value === "boolean") {
    return { ...base, type: "boolean", default: Boolean(value) };
  }
  const multiline = opts.multiline === true || (!spec && input === "text");
  return { ...base, type: "text", default: String(value), ...(multiline ? { multiline } : {}) };
}

function compareNodeIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/** Every literal input of the graph, in node-id order, with an inferred field definition. */
export function listInputCandidates(graph: ApiGraph, objectInfo?: ObjectInfo): InputCandidate[] {
  const out: InputCandidate[] = [];
  for (const nodeId of Object.keys(graph).toSorted(compareNodeIds)) {
    const node = graph[nodeId]!;
    const info = objectInfo?.[node.class_type];
    for (const [input, value] of Object.entries(node.inputs)) {
      if (!isLiteral(value)) continue;
      out.push({
        nodeId,
        classType: node.class_type,
        nodeTitle: node._meta?.title || info?.display_name || node.class_type,
        input,
        value,
        param: inferParam(nodeId, node, input, value, info),
      });
    }
  }
  return out;
}

/** Inputs worth exposing by default: prompts, sampler knobs, size, checkpoint, input image. */
const SUGGESTED: Record<string, string[]> = {
  CLIPTextEncode: ["text"],
  KSampler: ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  KSamplerAdvanced: ["noise_seed", "steps", "cfg", "sampler_name", "scheduler"],
  RandomNoise: ["noise_seed"],
  EmptyLatentImage: ["width", "height", "batch_size"],
  EmptySD3LatentImage: ["width", "height", "batch_size"],
  CheckpointLoaderSimple: ["ckpt_name"],
  LoraLoader: ["lora_name", "strength_model", "strength_clip"],
  LoraLoaderModelOnly: ["lora_name", "strength_model"],
  VAELoader: ["vae_name"],
  UNETLoader: ["unet_name"],
  UpscaleModelLoader: ["model_name"],
  LoadImage: ["image"],
  LoadAudio: ["audio"],
  LoadVideo: ["file"],
  VHS_LoadVideo: ["video"],
  VHS_LoadAudio: ["audio_file"],
};

/** Default field set for a freshly uploaded workflow. Falls back to every text input. */
export function suggestParams(candidates: InputCandidate[]): WorkflowParam[] {
  const picked = candidates.filter((c) => SUGGESTED[c.classType]?.includes(c.input));
  const list = picked.length > 0 ? picked : candidates.filter((c) => c.param.type === "text");
  return list.map((c) => c.param);
}

/** Field definitions accepted from the editor; the graph decides whether they bind. */
export const workflowParamSchema = z.object({
  id: z.string().min(1).max(200),
  nodeId: z.string().min(1).max(100),
  input: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  type: z.enum(PARAM_TYPES),
  default: z.union([z.string().max(200_000), z.number(), z.boolean()]),
  multiline: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  options: z.array(z.string().max(1000)).max(5000).optional(),
});

/** Drops params whose node/input no longer exists as a literal, and duplicate bindings. */
export function bindableParams(graph: ApiGraph, params: WorkflowParam[]): WorkflowParam[] {
  const seen = new Set<string>();
  return params.filter((p) => {
    const id = `${p.nodeId}.${p.input}`;
    if (p.id !== id || seen.has(id)) return false;
    seen.add(id);
    return isLiteral(graph[p.nodeId]?.inputs[p.input]);
  });
}

export class ParamValueError extends Error {}

/** Coerces one submitted value to what the field accepts. Throws `ParamValueError` otherwise. */
export function coerceParamValue(param: WorkflowParam, raw: unknown): string | number | boolean {
  const fail = (why: string): ParamValueError => new ParamValueError(`'${param.label}': ${why}`);
  switch (param.type) {
    case "text":
    case "select":
    case "image":
    case "audio":
    case "video": {
      if (typeof raw !== "string") throw fail("문자열이어야 합니다");
      const s = raw;
      if (s.length > 200_000) throw fail("너무 깁니다");
      if (isMediaParam(param.type) && !s) throw fail("파일을 선택하세요");
      return s;
    }
    case "boolean":
      if (typeof raw !== "boolean") throw fail("true/false여야 합니다");
      return raw;
    case "integer":
    case "seed":
    case "number":
    default: {
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) throw fail("숫자여야 합니다");
      const v = n;
      if (param.type !== "number" && !Number.isInteger(v)) throw fail("정수여야 합니다");
      if (param.type === "seed" && (v < 0 || v > MAX_SEED))
        throw fail(`0~${MAX_SEED} 범위여야 합니다`);
      if (param.min !== undefined && v < param.min) throw fail(`${param.min} 이상이어야 합니다`);
      if (param.max !== undefined && v > param.max) throw fail(`${param.max} 이하여야 합니다`);
      return v;
    }
  }
}

/**
 * The graph to queue: a copy of `graph` with each param's value (or its default) written into
 * its input. Values for unknown param ids are ignored; the graph itself is never mutated.
 */
/**
 * The template's fields re-based on a patched copy of its graph: fields whose input is still a
 * literal; for the inputs the patch gave a literal (`pinned`, see `applyGraphPatch`) that literal becomes
 * the default, the others keep their stored default (it may differ from the template's literal —
 * `updateWorkflow` saves defaults on their own — so value equality cannot tell "set to the same
 * value" from "untouched"). Every path that binds form values to a patched graph must use this,
 * or `applyParams` would write the old default over what the patch set (a proposal that changes
 * the prompt but sends only seeds would lose the prompt).
 */
export function rebaseParams(
  patched: ApiGraph,
  params: WorkflowParam[],
  pinned: ReadonlySet<string>,
): WorkflowParam[] {
  return bindableParams(patched, params).map((p) =>
    pinned.has(p.id)
      ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bindableParams above kept only params whose input is a literal in `patched`
        { ...p, default: patched[p.nodeId]!.inputs[p.input] as WorkflowParam["default"] }
      : p,
  );
}

export function applyParams(
  graph: ApiGraph,
  params: WorkflowParam[],
  values: Record<string, unknown>,
): ApiGraph {
  const out = structuredClone(graph);
  for (const p of bindableParams(graph, params)) {
    const raw = Object.hasOwn(values, p.id) ? values[p.id] : p.default;
    out[p.nodeId]!.inputs[p.input] = coerceParamValue(p, raw);
  }
  return out;
}

/** Distinct node classes, for fetching `/object_info` per class. */
export function nodeClasses(graph: ApiGraph): string[] {
  return [...new Set(Object.values(graph).map((n) => n.class_type))];
}

/** Random seed for "랜덤 시드"; uses crypto so batches started together differ. */
export function randomSeed(): number {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  // 53 bits: 21 high bits + 32 low bits.
  return (buf[0]! & 0x1fffff) * 0x100000000 + buf[1]!;
}
