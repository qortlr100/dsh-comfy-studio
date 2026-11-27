import { z } from "zod";
import type { AssetKind } from "./types.ts";
import { parseApiGraph, type ApiGraph } from "./workflow.ts";

/**
 * Parsers for what ComfyUI sends back: `/ws` JSON frames and `/history/{prompt_id}` entries.
 * Everything is narrowed with zod and unknown shapes are ignored, since custom nodes and
 * newer server versions add fields and message types freely.
 */

/** Normalized `/ws` message for one prompt. Messages for other prompts are filtered out. */
export type ComfyWsEvent =
  | { type: "started" }
  | { type: "executing"; node: string }
  | { type: "progress"; value: number; max: number; node: string | null }
  | { type: "cached"; nodes: string[] }
  | { type: "success" }
  | { type: "error"; message: string }
  | { type: "interrupted" };

const wsFrameSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isInputFolder(v: unknown): v is "input" | "output" | "temp" {
  return v === "input" || v === "output" || v === "temp";
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

/**
 * Parses one text frame. Returns null for frames about other prompts, frames without a
 * prompt id that we cannot attribute, and message types we do not use (`status`, previews).
 */
export function parseWsMessage(raw: string, promptId: string): ComfyWsEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const frame = wsFrameSchema.safeParse(json);
  if (!frame.success) return null;
  const { type, data = {} } = frame.data;
  if (str(data.prompt_id) !== promptId) return null;
  switch (type) {
    case "execution_start":
      return { type: "started" };
    case "executing": {
      const node = str(data.node);
      // `node: null` is the legacy "prompt finished" signal.
      return node === null ? { type: "success" } : { type: "executing", node };
    }
    case "progress": {
      const value = typeof data.value === "number" ? data.value : null;
      const max = typeof data.max === "number" ? data.max : null;
      if (value === null || max === null || max <= 0) return null;
      return { type: "progress", value, max, node: str(data.node) };
    }
    case "execution_cached":
      return {
        type: "cached",
        nodes: Array.isArray(data.nodes) ? data.nodes.map(str).filter((n) => n !== null) : [],
      };
    case "execution_success":
      return { type: "success" };
    case "execution_error":
      return { type: "error", message: executionErrorMessage(data) };
    case "execution_interrupted":
      return { type: "interrupted" };
    default:
      return null;
  }
}

function executionErrorMessage(data: Record<string, unknown>): string {
  const nodeType = str(data.node_type);
  const message = str(data.exception_message)?.trim() || "실행 중 오류가 발생했습니다";
  return nodeType ? `${nodeType}: ${message}` : message;
}

/** One file listed under a node's outputs. */
export interface OutputFile {
  nodeId: string;
  filename: string;
  subfolder: string;
  /** "output" for saved files, "temp" for previews. */
  type: string;
  /**
   * Backends that leave files on a volume instead of serving `/view` (RunPod): the path under
   * the volume's `output/`. Not part of the file's identity (`outputKey`).
   */
  volumePath?: string;
}

/**
 * Step/node progress a backend reports through polling rather than a socket. Its presence means
 * the run has started; all-null fields mean started without detail.
 */
export interface PolledProgress {
  node: string | null;
  value: number | null;
  max: number | null;
}

export type HistoryResult =
  | { state: "pending"; progress?: PolledProgress | null }
  | { state: "succeeded"; files: OutputFile[] }
  | { state: "failed"; error: string }
  | { state: "interrupted" };

const fileSchema = z.object({
  filename: z.string().min(1),
  subfolder: z.string().optional().default(""),
  type: z.string().optional().default("output"),
});

const historyEntrySchema = z.object({
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional().default({}),
  status: z
    .object({
      status_str: z.string().optional(),
      completed: z.boolean().optional(),
      messages: z.array(z.unknown()).optional(),
    })
    .optional(),
});

/** Output keys that carry file lists. `images` also holds animated webp/gif from SaveAnimated*. */
const FILE_OUTPUT_KEYS = ["images", "gifs", "videos", "video", "audio", "animated", "files"];

function collectFiles(outputs: Record<string, Record<string, unknown>>): OutputFile[] {
  const files: OutputFile[] = [];
  const seen = new Set<string>();
  for (const [nodeId, out] of Object.entries(outputs)) {
    for (const key of FILE_OUTPUT_KEYS) {
      const list = out[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const f = fileSchema.safeParse(item);
        if (!f.success) continue;
        const id = `${f.data.type}/${f.data.subfolder}/${f.data.filename}`;
        if (seen.has(id)) continue;
        seen.add(id);
        files.push({ nodeId, ...f.data });
      }
    }
  }
  return files;
}

function historyError(messages: unknown[] | undefined): string {
  for (const m of messages ?? []) {
    if (!Array.isArray(m) || m[0] !== "execution_error") continue;
    const data: unknown = m[1];
    if (isRecord(data)) return executionErrorMessage(data);
  }
  return "실행 중 오류가 발생했습니다";
}

/** Saved outputs win; previews are kept only when nothing was saved. */
function preferSaved(files: OutputFile[]): OutputFile[] {
  const saved = files.filter((f) => f.type === "output");
  return saved.length > 0 ? saved : files;
}

/** Where one parsed history entry stands; shared by `parseHistory` and `parseHistoryList`. */
function entryResult(entry: z.infer<typeof historyEntrySchema>): HistoryResult {
  const { outputs, status } = entry;
  const messages = status?.messages ?? [];
  // An interrupt is also recorded as status_str "error"; check it first.
  if (messages.some((m) => Array.isArray(m) && m[0] === "execution_interrupted"))
    return { state: "interrupted" };
  if (status?.status_str === "error") return { state: "failed", error: historyError(messages) };
  if (status && status.completed === false && status.status_str !== "success")
    return { state: "pending" };
  return { state: "succeeded", files: preferSaved(collectFiles(outputs)) };
}

/**
 * Reads `/history/{prompt_id}`. The body is `{ [promptId]: entry }`, or `{}` while the prompt is
 * still queued or running. Saved outputs win; previews are kept only when nothing was saved,
 * so a workflow ending in PreviewImage still produces something.
 */
export function parseHistory(body: unknown, promptId: string): HistoryResult {
  if (!isRecord(body)) return { state: "pending" };
  const raw = body[promptId];
  if (raw === undefined) return { state: "pending" };
  const entry = historyEntrySchema.safeParse(raw);
  if (!entry.success) return { state: "pending" };
  return entryResult(entry.data);
}

/**
 * A finished run in a server's history, with the API graph it ran. The UI-format graph ComfyUI
 * keeps beside it (`extra_pnginfo.workflow`) is dropped: nothing reads it yet.
 */
export interface ServerRun {
  promptId: string;
  /** When it was queued (`extra_data.create_time`), else when it started executing. */
  queuedAt?: Date;
  graph: ApiGraph;
  /** Saved outputs, or the previews when nothing was saved (as `parseHistory`). */
  outputs: OutputFile[];
  status: "succeeded" | "failed" | "interrupted";
}

/** `prompt` of a history entry: `[number, prompt_id, graph, extra_data, outputs_to_execute]`. */
const historyPromptSchema = z
  .tuple([z.number().optional(), z.unknown(), z.unknown()])
  .rest(z.unknown());

function timestampOf(v: unknown): Date | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v) : undefined;
}

/** Queue time from `extra_data.create_time`, else the `execution_start` message's timestamp. */
function runTime(extra: unknown, messages: unknown[] | undefined): Date | undefined {
  if (isRecord(extra)) {
    const created = timestampOf(extra.create_time);
    if (created) return created;
  }
  for (const m of messages ?? []) {
    if (!Array.isArray(m) || m[0] !== "execution_start") continue;
    const data: unknown = m[1];
    if (isRecord(data)) return timestampOf(data.timestamp);
  }
  return undefined;
}

/**
 * Reads `/history?max_items=N` (`{ [promptId]: entry }`, oldest first) into finished runs, most
 * recent first. Each entry's API graph is `prompt[2]`; entries without a readable graph and runs
 * still in flight are skipped. Status and outputs follow `parseHistory`.
 */
export function parseHistoryList(body: unknown): ServerRun[] {
  if (!isRecord(body) || Array.isArray(body)) return [];
  const runs: { run: ServerRun; number: number | undefined; index: number }[] = [];
  let index = 0;
  for (const [promptId, raw] of Object.entries(body)) {
    index++;
    const entry = historyEntrySchema.safeParse(raw);
    if (!entry.success) continue;
    const prompt = historyPromptSchema.safeParse(isRecord(raw) ? raw.prompt : undefined);
    if (!prompt.success) continue;
    let graph: ApiGraph;
    try {
      graph = parseApiGraph(prompt.data[2]);
    } catch {
      continue;
    }
    const result = entryResult(entry.data);
    if (result.state === "pending") continue;
    const queuedAt = runTime(prompt.data[3], entry.data.status?.messages);
    runs.push({
      run: {
        promptId,
        ...(queuedAt ? { queuedAt } : {}),
        graph,
        // A failed or interrupted run may still have saved something before it stopped.
        outputs:
          result.state === "succeeded"
            ? result.files
            : preferSaved(collectFiles(entry.data.outputs)),
        status: result.state,
      },
      number: prompt.data[0],
      index,
    });
  }
  // The queue number orders runs as the server took them; the body's own order is the fallback.
  return runs
    .toSorted((a, b) =>
      a.number !== undefined && b.number !== undefined && a.number !== b.number
        ? b.number - a.number
        : b.index - a.index,
    )
    .map((r) => r.run);
}

/** Comfy Cloud job states that end a job (`GET /api/job/{id}/status`); anything else is in flight. */
const CLOUD_FAILED = new Set(["error", "non_retryable_error", "lost"]);

/**
 * Reads Comfy Cloud's job status. Only `success` moves on to collecting outputs; failures carry
 * whatever message the body has; `cancelled` maps to an interrupt.
 */
export function parseCloudJobStatus(
  body: unknown,
):
  | { state: "pending" }
  | { state: "succeeded" }
  | { state: "interrupted" }
  | { state: "failed"; error: string } {
  const b: Record<string, unknown> = isRecord(body) ? body : {};
  const status = str(b.status)?.toLowerCase() ?? "";
  if (status === "success" || status === "completed") return { state: "succeeded" };
  if (status === "cancelled" || status === "canceled") return { state: "interrupted" };
  if (CLOUD_FAILED.has(status)) {
    const message = [b.error_message, b.error, b.message].map(str).find((m) => m?.trim());
    return { state: "failed", error: message?.trim() || `Comfy Cloud 작업 실패 (${status})` };
  }
  return { state: "pending" };
}

/**
 * Output files from a Comfy Cloud history response for a job that already succeeded. Accepts the
 * local shape (`{ [id]: entry }`), the v2 list (`{ history: [entry] }`) and a bare entry.
 */
export function parseCloudOutputs(body: unknown, promptId: string): OutputFile[] {
  if (!isRecord(body)) return [];
  const b = body;
  let raw: unknown = b[promptId];
  if (raw === undefined && Array.isArray(b.history)) {
    const list: unknown[] = b.history;
    raw = list.find((e) => isRecord(e) && str(e.prompt_id) === promptId) ?? list[0];
  }
  if (raw === undefined && b.outputs) raw = b;
  const entry = historyEntrySchema.safeParse(raw);
  if (!entry.success) return [];
  return preferSaved(collectFiles(entry.data.outputs));
}

const MIME_BY_EXT: Record<string, { mime: string; kind: AssetKind }> = {
  png: { mime: "image/png", kind: "image" },
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
  gif: { mime: "image/gif", kind: "image" },
  avif: { mime: "image/avif", kind: "image" },
  mp4: { mime: "video/mp4", kind: "video" },
  webm: { mime: "video/webm", kind: "video" },
  mov: { mime: "video/quicktime", kind: "video" },
  mkv: { mime: "video/x-matroska", kind: "video" },
  mp3: { mime: "audio/mpeg", kind: "audio" },
  wav: { mime: "audio/wav", kind: "audio" },
  flac: { mime: "audio/flac", kind: "audio" },
  ogg: { mime: "audio/ogg", kind: "audio" },
  opus: { mime: "audio/opus", kind: "audio" },
  m4a: { mime: "audio/mp4", kind: "audio" },
};

export function extensionOf(filename: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filename);
  return m ? m[1]!.toLowerCase() : "";
}

/**
 * Media type from the file name. Anything unrecognized is stored as an opaque download, so the
 * app never serves e.g. HTML or SVG from its own origin as something a browser would render.
 */
export function classifyOutput(filename: string): { mime: string; kind: AssetKind; ext: string } {
  const ext = extensionOf(filename);
  const known = MIME_BY_EXT[ext];
  return known
    ? { ...known, ext }
    : { mime: "application/octet-stream", kind: "file", ext: ext || "bin" };
}

/** Media types the asset route may serve inline. */
export function isInlineMime(mime: string): boolean {
  return Object.values(MIME_BY_EXT).some((m) => m.mime === mime);
}

/**
 * Splits a LoadImage field value (`name.png`, `sub/dir/name.png`, optionally with a trailing
 * ` [input]`/` [output]`/` [temp]` annotation) into `/view` query parts. Returns null for values
 * that could escape the server's folder; ComfyUI checks too, but nothing odd is forwarded.
 */
export function parseInputImageRef(
  value: string,
): { filename: string; subfolder: string; type: "input" | "output" | "temp" } | null {
  const m = /^(.*?)\s*\[(input|output|temp)\]$/.exec(value);
  const path = (m ? m[1]! : value).trim();
  const folder = m?.[2];
  const type = isInputFolder(folder) ? folder : "input";
  // oxlint-disable-next-line eslint/no-control-regex -- refuses backslashes and control characters in a path
  if (!path || path.startsWith("/") || /[\\\x00-\x1f]/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  const filename = parts.pop()!;
  return { filename, subfolder: parts.join("/"), type };
}

/**
 * Whether a stored field value names an image file in the server's folders. Used to keep
 * previewing image inputs of old generations after the workflow (or just the field) is gone
 * and the param type can no longer be looked up.
 */
export function looksLikeImageInput(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const ref = parseInputImageRef(value);
  return ref !== null && classifyOutput(ref.filename).kind === "image";
}

const KEPT_METADATA_KEYS = [
  "modelspec.architecture",
  "modelspec.title",
  "modelspec.trigger_phrase",
  "modelspec.usage_hint",
  "ss_base_model_version",
  "ss_output_name",
  "ss_sd_model_name",
  "ss_network_module",
] as const;
const MAX_METADATA_VALUE = 300;
const MAX_TRIGGER_WORDS = 30;
const MAX_TRIGGER_WORD = 100;

/** Tags of kohya's `ss_tag_frequency` (`{ dir: { tag: count } }`), counts summed, most frequent first. */
function tagFrequencyTags(raw: string | undefined): string[] {
  if (!raw) return [];
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const counts = new Map<string, number>();
  for (const dir of Object.values(body)) {
    if (!dir || typeof dir !== "object" || Array.isArray(dir)) continue;
    for (const [tag, n] of Object.entries(dir)) {
      const t = tag.trim();
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + (typeof n === "number" && Number.isFinite(n) ? n : 0));
    }
  }
  // Array.prototype.toSorted is stable, so ties keep the order first seen.
  return [...counts].toSorted((a, b) => b[1] - a[1]).map(([t]) => t);
}

/**
 * What the app keeps of a model file's safetensors `__metadata__`: a few identifying keys (values
 * cut short) and the trigger words a LoRA declares or was trained with. Never throws.
 */
export function parseModelMetadata(raw: Readonly<Record<string, string>> | null): {
  metadata: Record<string, string> | null;
  triggerWords: string[];
} {
  if (!raw) return { metadata: null, triggerWords: [] };
  const metadata: Record<string, string> = {};
  for (const key of KEPT_METADATA_KEYS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) metadata[key] = v.slice(0, MAX_METADATA_VALUE);
  }
  const candidates: string[] = [];
  const phrase = raw["modelspec.trigger_phrase"];
  if (typeof phrase === "string") candidates.push(phrase.trim());
  candidates.push(...tagFrequencyTags(raw["ss_tag_frequency"]));
  const seen = new Set<string>();
  const triggerWords: string[] = [];
  for (const c of candidates) {
    // A tag is a word or a short phrase: one with a line break or another control character
    // is not shown to the user or the agent (it ends up in the system text).
    // oxlint-disable-next-line eslint/no-control-regex -- drops tags containing control characters
    if (!c || c.length > MAX_TRIGGER_WORD || /[\u0000-\u001f\u007f]/.test(c)) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    triggerWords.push(c);
    if (triggerWords.length >= MAX_TRIGGER_WORDS) break;
  }
  return {
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
    triggerWords,
  };
}
