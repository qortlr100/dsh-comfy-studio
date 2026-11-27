import { z } from "zod";
import type { ComfyServerKind } from "./types.ts";
import { parseObjectInfo, type ApiGraph, type ObjectInfo } from "./workflow.ts";
import {
  capBytes,
  ComfyError,
  MAX_OUTPUT_BYTES,
  HISTORY_SERVER_KINDS,
  MODEL_META_SERVER_KINDS,
  type CancelOutcome,
  type ComfyBackend,
  type SystemStats,
} from "./backend.ts";
import { assetModelFolders, mergeModelFiles, modelFoldersFor } from "./model-loaders.ts";
import {
  parseCloudJobStatus,
  parseCloudOutputs,
  parseHistory,
  parseHistoryList,
  type HistoryResult,
  type ServerRun,
} from "./protocol.ts";

/** What the client needs to reach one server. The key is already decrypted. */
export interface ComfyConfig {
  kind: ComfyServerKind;
  baseUrl: string;
  apiKey: string | null;
}

// Shared with the other backends; re-exported so existing imports keep working.
export { ComfyError, MAX_OUTPUT_BYTES, type SystemStats } from "./backend.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const OBJECT_INFO_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

const systemStatsSchema = z.object({
  system: z
    .object({
      os: z.string().optional(),
      python_version: z.string().optional(),
      comfyui_version: z.string().optional(),
    })
    .passthrough()
    .optional(),
  devices: z
    .array(
      z
        .object({
          name: z.string().optional(),
          type: z.string().optional(),
          vram_total: z.number().optional(),
          vram_free: z.number().optional(),
        })
        .passthrough(),
    )
    .optional(),
});

const queuePromptSchema = z.object({
  prompt_id: z.string().min(1),
  node_errors: z.record(z.string(), z.unknown()).optional(),
});

/** `/api/assets` page (Comfy Cloud model library); only the fields we read. */
const assetPageSchema = z.object({
  assets: z.array(
    z
      .object({
        name: z.string(),
        tags: z.array(z.string()).optional(),
        loader_path: z.string().nullish(),
        user_metadata: z.object({ filename: z.string().optional() }).passthrough().nullish(),
        metadata: z.object({ filename: z.string().optional() }).passthrough().nullish(),
      })
      .passthrough(),
  ),
  has_more: z.boolean().optional(),
  next_cursor: z.string().nullish(),
});
/** Pages of `ASSET_PAGE_SIZE` the model library may span before we stop reading. */
const MAX_ASSET_PAGES = 20;
const ASSET_PAGE_SIZE = 500;

const uploadSchema = z.object({
  name: z.string().min(1),
  subfolder: z.string().optional().default(""),
  type: z.string().optional(),
});

/**
 * Thin client over the ComfyUI HTTP API and `/ws`. Self-hosted servers expose the routes at the
 * root (`/prompt`); Comfy Cloud serves them under `/api` and wants `X-API-Key`. A key on a local
 * server is sent as a bearer token, for servers behind an authenticating reverse proxy.
 */
export class ComfyClient implements ComfyBackend {
  private readonly root: string;
  private readonly prefix: string;
  /** Present only for the kinds in `HISTORY_SERVER_KINDS`, so callers can tell by its absence. */
  readonly listHistory?: (limit: number) => Promise<ServerRun[]>;

  /** Present only for the kinds in `MODEL_META_SERVER_KINDS`. */
  readonly listModels?: (folder: string) => Promise<string[]>;
  readonly modelMetadata?: (folder: string, file: string) => Promise<Record<string, string> | null>;
  private readonly cfg: ComfyConfig;

  constructor(cfg: ComfyConfig) {
    this.cfg = cfg;
    this.root = cfg.baseUrl.replace(/\/+$/, "");
    if (cfg.kind === "cloud") this.root = this.root.replace(/\/api$/, "");
    this.prefix = cfg.kind === "cloud" ? "/api" : "";
    if (HISTORY_SERVER_KINDS.includes(cfg.kind))
      this.listHistory = (limit) => this.recentHistory(limit);
    if (MODEL_META_SERVER_KINDS.includes(cfg.kind)) {
      this.listModels = (folder) => this.modelFiles(folder);
      this.modelMetadata = (folder, file) => this.safetensorsMetadata(folder, file);
    }
  }

  private headers(): Record<string, string> {
    if (!this.cfg.apiKey) return {};
    return this.cfg.kind === "cloud"
      ? { "X-API-Key": this.cfg.apiKey }
      : { Authorization: `Bearer ${this.cfg.apiKey}` };
  }

  url(path: string, query?: Record<string, string>): string {
    const u = new URL(`${this.root}${this.prefix}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
    return u.toString();
  }

  private async request(
    path: string,
    init: RequestInit & { query?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response> {
    const { query, timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
    let res: Response;
    try {
      res = await fetch(this.url(path, query), {
        ...rest,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every caller passes a plain object literal; a Headers instance or tuple array would not spread correctly either way
        headers: { ...this.headers(), ...(rest.headers as Record<string, string> | undefined) },
        signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (err) {
      throw networkError(err);
    }
    if (res.status === 401 || res.status === 403)
      throw new ComfyError("ComfyUI 인증에 실패했습니다. API 키를 확인하세요", res.status);
    return res;
  }

  private async json(path: string, init?: Parameters<ComfyClient["request"]>[1]) {
    const res = await this.request(path, init);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* Non-JSON error pages fall through to the status check. */
    }
    if (!res.ok) throw new ComfyError(errorMessage(body, res), res.status);
    return body;
  }

  async systemStats(): Promise<SystemStats> {
    const parsed = systemStatsSchema.safeParse(await this.json("/system_stats"));
    if (!parsed.success) throw new ComfyError("ComfyUI 응답 형식이 아닙니다 (/system_stats)");
    const { system, devices = [] } = parsed.data;
    return {
      comfyuiVersion: system?.comfyui_version ?? null,
      pythonVersion: system?.python_version?.split(" ")[0] ?? null,
      os: system?.os ?? null,
      devices: devices.map((d) => ({
        name: d.name ?? "unknown",
        type: d.type ?? "unknown",
        vramTotal: d.vram_total ?? null,
        vramFree: d.vram_free ?? null,
      })),
    };
  }

  /**
   * Node definitions for the given classes. Unknown classes are simply absent. On Comfy Cloud
   * the model loaders' choices also include the account's model library (imported models are
   * not in `/object_info`); a library that cannot be read leaves the definitions as served.
   */
  async objectInfo(classes: string[]): Promise<ObjectInfo> {
    const out: ObjectInfo = {};
    if (this.cfg.kind === "cloud") {
      // Comfy Cloud only serves the bulk `/api/object_info`; pick the classes we need from it.
      const raw = await this.json("/object_info", { timeoutMs: OBJECT_INFO_TIMEOUT_MS });
      const body = isRecord(raw) ? raw : null;
      for (const c of classes) {
        const info = body?.[c];
        if (info && typeof info === "object") out[c] = info;
      }
      if (modelFoldersFor(classes).length > 0) {
        try {
          return mergeModelFiles(out, await this.modelLibrary());
        } catch (err) {
          console.warn(
            "[comfy] model library unavailable:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      return out;
    }
    const results = await Promise.allSettled(
      classes.map(async (c) => {
        const body = await this.json(`/object_info/${encodeURIComponent(c)}`, {
          timeoutMs: OBJECT_INFO_TIMEOUT_MS,
        });
        const info = (isRecord(body) ? body : null)?.[c];
        if (info && typeof info === "object") out[c] = info;
      }),
    );
    // Report a dead server, not a missing custom node.
    const failed = results.find(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" && !(r.reason instanceof ComfyError && r.reason.status === 404),
    );
    if (failed && Object.keys(out).length === 0) throw failed.reason;
    return out;
  }

  /**
   * Every node class from the bulk `/object_info` (megabytes; `lib/comfy/node-catalog.ts`
   * caches it). On Comfy Cloud the model library is merged into the loaders as in `objectInfo`.
   */
  async listNodeClasses(): Promise<ObjectInfo> {
    const all = parseObjectInfo(
      await this.json("/object_info", { timeoutMs: OBJECT_INFO_TIMEOUT_MS }),
    );
    if (this.cfg.kind !== "cloud") return all;
    try {
      return mergeModelFiles(all, await this.modelLibrary());
    } catch (err) {
      console.warn("[comfy] model library unavailable:", err instanceof Error ? err.message : err);
      return all;
    }
  }

  /**
   * The account's model library (not the public catalog, which `/object_info` already covers)
   * as files per model folder, in library order. One walk over the `models` assets, bucketed by
   * their tags, so both the `model_type:<folder>` and the bare `<folder>` tag schemes work
   * without asking the server which it uses. The value is what the Cloud UI resolves a model
   * to: the category-relative loader path, else (legacy records only) the filename metadata,
   * else the asset name.
   */
  async modelLibrary(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const typedBackend = await this.supportsModelTypeTags();
    let after: string | undefined;
    for (let page = 0; page < MAX_ASSET_PAGES; page++) {
      const body = await this.json("/assets", {
        query: {
          include_tags: "models",
          exclude_tags: "missing",
          include_public: "false",
          limit: String(ASSET_PAGE_SIZE),
          ...(after ? { after } : {}),
        },
        timeoutMs: OBJECT_INFO_TIMEOUT_MS,
      });
      const parsed = assetPageSchema.safeParse(body);
      if (!parsed.success) throw new ComfyError("ComfyUI가 모델 목록을 돌려주지 않았습니다");
      for (const a of parsed.data.assets) {
        const folders = assetModelFolders(a.tags ?? []);
        // On a backend with the `model_type:` scheme a record without a loader path is one it
        // cannot load (an orphan, or not migrated yet), as in the Cloud UI's bucketing. Without
        // that answer, the record's own tags decide. The filename fallback is for legacy records.
        const typed = typedBackend ?? (a.tags ?? []).some((t) => t.startsWith("model_type:"));
        const name =
          a.loader_path ||
          (typed ? null : a.user_metadata?.filename || a.metadata?.filename || a.name);
        if (!name) continue;
        for (const folder of folders) {
          const files = out.get(folder) ?? [];
          if (!files.includes(name)) files.push(name);
          out.set(folder, files);
        }
      }
      if (!parsed.data.has_more || !parsed.data.next_cursor) break;
      after = parsed.data.next_cursor;
    }
    return out;
  }

  /**
   * Whether the server tags models `model_type:<folder>` and serves `loader_path`
   * (`supports_model_type_tags` in `/features`); null when it does not say.
   */
  private async supportsModelTypeTags(): Promise<boolean | null> {
    try {
      const raw = await this.json("/features");
      const body = isRecord(raw) ? raw : null;
      const flag = body?.supports_model_type_tags;
      return typeof flag === "boolean" ? flag : null;
    } catch {
      return null;
    }
  }

  async queuePrompt(graph: ApiGraph, clientId: string): Promise<string> {
    const body = await this.json("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: graph,
        client_id: clientId,
        // Comfy Cloud runs Partner Nodes (paid API nodes) only with the key in extra_data too.
        // Added to this request only; the stored graph never contains it.
        ...(this.cfg.kind === "cloud" && this.cfg.apiKey
          ? { extra_data: { api_key_comfy_org: this.cfg.apiKey } }
          : {}),
      }),
    });
    const parsed = queuePromptSchema.safeParse(body);
    if (!parsed.success) throw new ComfyError("ComfyUI가 prompt_id를 돌려주지 않았습니다");
    const nodeErrors = parsed.data.node_errors ?? {};
    if (Object.keys(nodeErrors).length > 0)
      throw new ComfyError(formatNodeErrors(nodeErrors) ?? "워크플로 검증에 실패했습니다");
    return parsed.data.prompt_id;
  }

  async history(promptId: string): Promise<unknown> {
    return this.json(`/history/${encodeURIComponent(promptId)}`);
  }

  /**
   * The last `limit` finished runs with their graphs, newest first (`GET /history?max_items=N`).
   * Bodies carry every run's graph twice (API and UI format), hence the long timeout.
   */
  private async recentHistory(limit: number): Promise<ServerRun[]> {
    const body = await this.json("/history", {
      query: { max_items: String(limit) },
      timeoutMs: OBJECT_INFO_TIMEOUT_MS,
    });
    return parseHistoryList(body);
  }

  /** `GET /models/{folder}`: the file names, as a loader input takes them. */
  private async modelFiles(folder: string): Promise<string[]> {
    const res = await this.request(`/models/${encodeURIComponent(folder)}`, {
      timeoutMs: OBJECT_INFO_TIMEOUT_MS,
    });
    if (!res.ok) throw new ComfyError(`모델 목록을 읽지 못했습니다 (${folder})`, res.status);
    const text = await readCapped(res, MODEL_META_MAX_BYTES);
    let body: unknown;
    try {
      body = text === null ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    if (!Array.isArray(body))
      throw new ComfyError(`모델 목록 응답이 올바르지 않습니다 (${folder})`);
    return body.filter((f): f is string => typeof f === "string");
  }

  /**
   * `GET /view_metadata/{folder}?filename=`: the safetensors `__metadata__`. ComfyUI answers 404
   * for a file that is not `.safetensors`, is missing, or has no metadata; any non-success, an
   * oversized body or a non-object body is null here too. Only string values are kept.
   */
  private async safetensorsMetadata(
    folder: string,
    file: string,
  ): Promise<Record<string, string> | null> {
    const res = await this.request(`/view_metadata/${encodeURIComponent(folder)}`, {
      query: { filename: file },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ComfyError(`모델 정보를 읽지 못했습니다 (${file})`, res.status);
    const text = await readCapped(res, MODEL_META_MAX_BYTES);
    if (!text) return null;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    return Object.keys(out).length > 0 ? out : null;
  }

  /**
   * Where the prompt stands, and its output files once it succeeded. Self-hosted servers answer
   * both from `/history/{id}`. Comfy Cloud reports state at `/api/job/{id}/status` and lists the
   * outputs of a finished job at `/api/history_v2/{id}` (the prompt id is the job id).
   */
  async result(promptId: string): Promise<HistoryResult> {
    const id = encodeURIComponent(promptId);
    if (this.cfg.kind !== "cloud") return parseHistory(await this.history(promptId), promptId);
    const status = parseCloudJobStatus(await this.json(`/job/${id}/status`));
    if (status.state !== "succeeded") return status;
    const files = parseCloudOutputs(await this.json(`/history_v2/${id}`), promptId);
    return { state: "succeeded", files };
  }

  /**
   * Removes the prompt from the queue; if it is executing, interrupts it and leaves the end
   * state to `/history` (interrupted → canceled, a run that finished first → its results). Socket
   * events can be missed (the prompt may start before the socket registers), so the server is
   * asked. If that fails, so does the cancel: older servers ignore `prompt_id` on `/interrupt`,
   * and guessing could stop someone else's running generation.
   */
  async cancel(promptId: string): Promise<CancelOutcome> {
    await this.deleteFromQueue(promptId);
    if (await this.isRunning(promptId)) {
      // The prompt may still finish before the interrupt lands; `result()` tells.
      await this.interrupt(promptId);
      return "running";
    }
    // Neither queued nor running: it may have just finished. A failed `/history` read throws
    // rather than guessing and dropping a finished run's results.
    const { state } = await this.result(promptId);
    return state === "succeeded" || state === "failed" ? "finished" : "canceled";
  }

  /** Cancels a prompt that has not started yet. */
  async deleteFromQueue(promptId: string): Promise<void> {
    await this.json("/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
    });
  }

  /** Whether the prompt is executing right now, per `GET /queue` (`queue_running`). */
  async isRunning(promptId: string): Promise<boolean> {
    const body = await this.json("/queue");
    const running: unknown[] =
      isRecord(body) && Array.isArray(body.queue_running) ? body.queue_running : [];
    // Entries are [number, prompt_id, prompt, extra_data, outputs].
    return running.some((entry) => Array.isArray(entry) && entry[1] === promptId);
  }

  /** Stops the running prompt. Newer servers only interrupt when `prompt_id` matches. */
  async interrupt(promptId: string): Promise<void> {
    await this.json("/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt_id: promptId }),
    });
  }

  /** Uploads a file into the server's input folder for LoadImage-style nodes. */
  async uploadImage(file: Blob, filename: string): Promise<string> {
    const form = new FormData();
    form.set("image", file, filename);
    form.set("type", "input");
    form.set("overwrite", "false");
    const parsed = uploadSchema.safeParse(
      await this.json("/upload/image", { method: "POST", body: form, timeoutMs: 120_000 }),
    );
    if (!parsed.success) throw new ComfyError("업로드 응답 형식이 올바르지 않습니다");
    const { name, subfolder } = parsed.data;
    return subfolder ? `${subfolder}/${name}` : name;
  }

  /**
   * Downloads an output file. Comfy Cloud answers `/view` with a redirect to a signed storage URL;
   * the key is only sent to the ComfyUI origin, never to the redirect target.
   */
  async view(file: {
    filename: string;
    subfolder: string;
    type: string;
  }): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null }> {
    let res = await this.request("/view", {
      query: { filename: file.filename, subfolder: file.subfolder, type: file.type },
      redirect: "manual",
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 5; hops++) {
      const location = res.headers.get("location");
      if (!location) break;
      const next = new URL(location, res.url || this.root);
      const sameOrigin = next.origin === new URL(this.root).origin;
      try {
        res = await fetch(next, {
          headers: sameOrigin ? this.headers() : {},
          redirect: "manual",
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
          cache: "no-store",
        });
      } catch (err) {
        throw networkError(err);
      }
    }
    if (!res.ok) throw new ComfyError(`출력 파일을 받지 못했습니다 (${res.status})`, res.status);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_OUTPUT_BYTES) throw new ComfyError("출력 파일이 너무 큽니다");
    // Handed to storage as a stream: a large video must never sit in memory whole.
    const body = (res.body ?? new Response(new Uint8Array()).body!).pipeThrough(
      capBytes(MAX_OUTPUT_BYTES),
    );
    return { body, contentType: res.headers.get("content-type") };
  }

  /**
   * Opens `/ws` for progress events. Node's WebSocket (undici) accepts headers for local proxies;
   * Comfy Cloud takes the key as a `token` query parameter instead.
   */
  openSocket(clientId: string): WebSocket {
    const u = new URL(`${this.root}/ws`);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("clientId", clientId);
    if (this.cfg.kind === "cloud" && this.cfg.apiKey) u.searchParams.set("token", this.cfg.apiKey);
    const init = { headers: this.cfg.kind === "cloud" ? {} : this.headers() };
    return new WebSocket(u, init);
  }
}

const MODEL_META_MAX_BYTES = 1024 * 1024;

/** The body as text, or null when it is longer than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function networkError(err: unknown): ComfyError {
  if (err instanceof ComfyError) return err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return new ComfyError("ComfyUI 서버 응답 시간이 초과되었습니다");
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return new ComfyError(`ComfyUI 서버에 연결할 수 없습니다${cause ? ` (${cause})` : ""}`);
}

/** Pulls a readable message out of ComfyUI's `{ error: {message, details}, node_errors }`. */
function errorMessage(body: unknown, res: Response): string {
  if (isRecord(body)) {
    const b = body;
    const nodeErrors = isRecord(b.node_errors) ? formatNodeErrors(b.node_errors) : null;
    if (nodeErrors) return nodeErrors;
    if (typeof b.error === "string") return b.error;
    if (isRecord(b.error)) {
      const e = b.error;
      const msg = typeof e.message === "string" ? e.message : null;
      const details = typeof e.details === "string" && e.details ? e.details : null;
      if (msg) return details ? `${msg}: ${details}` : msg;
    }
  }
  return `ComfyUI 요청 실패 (${res.status} ${res.statusText})`;
}

function formatNodeErrors(nodeErrors: Record<string, unknown>): string | null {
  const lines: string[] = [];
  for (const [nodeId, v] of Object.entries(nodeErrors)) {
    const entry: Record<string, unknown> = isRecord(v) ? v : {};
    const errors: unknown[] = Array.isArray(entry.errors) ? entry.errors : [];
    for (const e of errors.slice(0, 3)) {
      const err: Record<string, unknown> = isRecord(e) ? e : {};
      const msg = typeof err.message === "string" ? err.message : "오류";
      const details = typeof err.details === "string" && err.details ? ` (${err.details})` : "";
      const cls = typeof entry.class_type === "string" ? ` ${entry.class_type}` : "";
      lines.push(`노드 ${nodeId}${cls}: ${msg}${details}`);
    }
  }
  return lines.length > 0 ? lines.slice(0, 6).join("\n") : null;
}
