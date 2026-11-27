import { shortId } from "../support/short-id.ts";
import { z } from "zod";
import {
  capBytes,
  ComfyError,
  MAX_OUTPUT_BYTES,
  type CancelOutcome,
  type ComfyBackend,
  type SystemStats,
  type ViewRef,
} from "../backend.ts";
import { classifyOutput, type HistoryResult, type OutputFile } from "../protocol.ts";
import { parseObjectInfo, type ApiGraph, type ObjectInfo } from "../workflow.ts";
import { parseJobOutput, parseJobStatus, parseRunResponse } from "../runpod/protocol.ts";
import { hasUploadInput, pickNodeInfo, withInputFiles } from "../runpod/object-info.ts";

/** What the client needs to reach the gateway on Modal. The token is already decrypted. */
export interface ModalConfig {
  /** Gateway URL, with the GPU profile path if any (`https://<workspace>--<app>.modal.run/<profile>`). */
  baseUrl: string;
  /** Modal proxy auth token as stored: `<token id>:<token secret>`. */
  token: string;
}

const LABEL = "Modal";
const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

/**
 * Splits a proxy auth token into the `Modal-Key` / `Modal-Secret` pair. Stored as
 * `<id>:<secret>`; whitespace between the two (pasted from the dashboard) is accepted too.
 */
export function parseProxyToken(raw: string): { id: string; secret: string } | null {
  const m = /^\s*([^\s:]+)\s*[:\s]\s*([^\s:]+)\s*$/.exec(raw);
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

const healthSchema = z
  .object({
    gpu: z.string().nullish(),
    highvram: z.boolean().nullish(),
    snapshot: z.boolean().nullish(),
    /** `meta/worker.json`, as the worker writes it on start; null before the first start. */
    worker: z
      .object({
        image: z.string().nullish(),
        comfyui_version: z.string().nullish(),
        devices: z.array(z.string().nullable()).optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const inputsSchema = z.object({ files: z.array(z.string()) });

/**
 * Backend for a ComfyUI worker on Modal, behind an HTTP gateway: a CPU-only front that spawns
 * the GPU function, reads its progress from a Modal Dict and serves the worker's volume. Jobs
 * answer in RunPod's job API shapes, so the RunPod parsers read them; files go over the gateway
 * instead of S3. The path after the host picks the GPU profile, so one server row is one
 * profile. Auth is a Modal proxy auth token.
 */
export class ModalClient implements ComfyBackend {
  private readonly root: string;
  private readonly key: { id: string; secret: string };
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: ModalConfig, fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
    this.root = cfg.baseUrl.replace(/\/+$/, "");
    const key = parseProxyToken(cfg.token);
    if (!key) throw new ComfyError("Modal 프록시 토큰은 <토큰 ID>:<시크릿> 형식이어야 합니다");
    this.key = key;
  }

  /** One gateway call. Auth failures and non-2xx answers become `ComfyError`s. */
  private async request(
    path: string,
    init: RequestInit & { timeoutMs?: number; okStatuses?: number[] } = {},
  ): Promise<Response> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, okStatuses = [], ...rest } = init;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.root}${path}`, {
        ...rest,
        headers: {
          "Modal-Key": this.key.id,
          "Modal-Secret": this.key.secret,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- callers in this library only pass plain header records; Headers would lowercase the keys.
          ...(rest.headers as Record<string, string> | undefined),
        },
        signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
        throw new ComfyError("Modal 게이트웨이 응답 시간이 초과되었습니다");
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
      throw new ComfyError(`Modal 게이트웨이에 연결할 수 없습니다${cause ? ` (${cause})` : ""}`);
    }
    if (res.ok || okStatuses.includes(res.status)) return res;
    if (res.status === 401 || res.status === 403)
      throw new ComfyError("Modal 인증에 실패했습니다. 프록시 토큰을 확인하세요", res.status);
    const text = await res.text().catch(() => "");
    let detail: string | null = null;
    try {
      const body: unknown = JSON.parse(text);
      if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string")
        detail = body.detail;
    } catch {
      /* Non-JSON error pages fall through to the status line. */
    }
    throw new ComfyError(
      detail ?? `Modal 게이트웨이 요청 실패 (${res.status} ${res.statusText})`,
      res.status,
    );
  }

  private async api(path: string, init: Parameters<ModalClient["request"]>[1] = {}) {
    const res = await this.request(path, init);
    const text = await res.text();
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new ComfyError(`Modal 게이트웨이 응답 형식이 아닙니다 (${path})`);
    }
  }

  /**
   * `/health` proves the token and the URL (gateway only: it never wakes a GPU). The worker
   * record says which image and devices the worker last started with, for the server card.
   */
  async systemStats(): Promise<SystemStats> {
    const health = healthSchema.safeParse(await this.api("/health"));
    if (!health.success) throw new ComfyError("Modal 게이트웨이 응답 형식이 아닙니다 (/health)");
    const { gpu, highvram, snapshot, worker } = health.data;
    const parts = [
      gpu ? `GPU ${gpu}${highvram === false ? " · highvram 끔" : ""}` : null,
      worker?.image ? `이미지 ${worker.image}` : "볼륨에 워커 기록 없음(첫 실행 뒤 생김)",
      snapshot === false ? "노드 정보 스냅샷 없음" : null,
    ];
    return {
      comfyuiVersion: worker?.comfyui_version ?? null,
      pythonVersion: null,
      os: null,
      devices: (worker?.devices ?? [])
        .filter((d): d is string => typeof d === "string" && d.length > 0)
        .map((name) => ({ name, type: "cuda", vramTotal: null, vramFree: null })),
      note: parts.filter((p): p is string => !!p).join(" · "),
    };
  }

  /** `POST /run`; the gateway spawns the GPU function and answers with the call id. */
  async queuePrompt(graph: ApiGraph): Promise<string> {
    const body = await this.api("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { workflow: graph } }),
      timeoutMs: 60_000,
    });
    const id = parseRunResponse(body);
    if (!id) throw new ComfyError("Modal 게이트웨이가 작업 id를 돌려주지 않았습니다");
    return id;
  }

  /**
   * `GET /status/{id}`. Progress rides along while it runs; the gateway falls back to the
   * worker's record (`output/_jobs/<id>.json`) itself once Modal has dropped the result.
   */
  async result(callId: string): Promise<HistoryResult> {
    let body: unknown;
    try {
      body = await this.api(`/status/${encodeURIComponent(callId)}`);
    } catch (err) {
      if (err instanceof ComfyError && err.status === 404)
        return { state: "failed", error: "Modal이 이 작업을 찾지 못했습니다" };
      throw err;
    }
    const state = parseJobStatus(body, LABEL);
    if (!state) throw new ComfyError("Modal 게이트웨이 응답 형식이 아닙니다 (/status)");
    switch (state.status) {
      case "pending":
        return { state: "pending", progress: state.progress };
      case "failed":
        return { state: "failed", error: state.error };
      case "cancelled":
        return { state: "interrupted" };
      default: {
        if (state.output === null)
          return {
            state: "failed",
            error:
              "Modal이 결과를 더 보관하지 않고 볼륨에도 작업 기록이 없어 결과를 받을 수 없습니다",
          };
        const parsed = parseJobOutput(state.output, LABEL);
        if (parsed.kind === "failed") return { state: "failed", error: parsed.error };
        for (const w of parsed.warnings) console.warn(`[modal] ${callId}: ${w}`);
        return { state: "succeeded", files: parsed.files };
      }
    }
  }

  /**
   * `POST /cancel/{id}` answers with the state after it: a finished call is left alone, an
   * unfinished one is cancelled with its container (the worker runs one job at a time).
   */
  async cancel(callId: string): Promise<CancelOutcome> {
    const state = parseJobStatus(
      await this.api(`/cancel/${encodeURIComponent(callId)}`, { method: "POST" }),
      LABEL,
    );
    if (!state) throw new ComfyError("Modal 게이트웨이 응답 형식이 아닙니다 (/cancel)");
    switch (state.status) {
      case "cancelled":
        return "canceled";
      case "pending":
        return "running";
      default:
        return "finished";
    }
  }

  /**
   * Node definitions from the snapshot the worker leaves on the volume when it starts
   * (`meta/object_info.json`, served by the gateway without waking a GPU), cached by ETag.
   * Upload inputs get the live `input/` listing instead of the snapshot's.
   */
  async objectInfo(classes: string[]): Promise<ObjectInfo> {
    return this.withLiveInputs(pickNodeInfo(await this.snapshot(), classes));
  }

  async listNodeClasses(): Promise<ObjectInfo> {
    return this.withLiveInputs(parseObjectInfo(await this.snapshot()));
  }

  private async withLiveInputs(info: ObjectInfo): Promise<ObjectInfo> {
    if (!hasUploadInput(info)) return info;
    const parsed = inputsSchema.safeParse(await this.api("/inputs"));
    if (!parsed.success) throw new ComfyError("Modal 게이트웨이 응답 형식이 아닙니다 (/inputs)");
    const names = parsed.data.files.filter((n) => n.length > 0 && !n.includes("/"));
    return withInputFiles(
      info,
      names.toSorted((a, b) => a.localeCompare(b)),
    );
  }

  /** The parsed snapshot; re-read only when the gateway's ETag changed. Shared by every profile. */
  private async snapshot(): Promise<unknown> {
    const cacheKey = new URL(this.root).origin;
    const cached = snapshotCache().get(cacheKey);
    let res: Response;
    try {
      res = await this.request("/object_info", {
        headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
        timeoutMs: 120_000,
        okStatuses: [304],
      });
    } catch (err) {
      if (err instanceof ComfyError && err.status === 404)
        throw new ComfyError(
          "볼륨에 노드 정보 스냅샷(meta/object_info.json)이 없습니다. 워커가 한 번 기동하면 생깁니다",
          404,
        );
      throw err;
    }
    if (res.status === 304 && cached) return cached.body;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ComfyError("Modal 게이트웨이 응답 형식이 아닙니다 (/object_info)");
    }
    snapshotCache().set(cacheKey, { etag: res.headers.get("etag"), body });
    return body;
  }

  /**
   * Puts the file at the top of the volume's `input/`, where the worker reads it after
   * reloading the volume. The gateway overwrites silently, so the name gets a short unique suffix.
   */
  async uploadImage(file: Blob, filename: string): Promise<string> {
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    const name = `${stem}-${shortId(6)}${ext}`;
    await this.request(`/inputs/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: new Uint8Array(await file.arrayBuffer()),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    return name;
  }

  /** Streams an output (by the path the worker reported) or an input (by name) off the volume. */
  async view(
    file: ViewRef,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null }> {
    let path: string;
    if (file.type === "input") {
      if (file.subfolder) throw new ComfyError("볼륨 입력은 하위 폴더를 쓰지 않습니다", 404);
      path = `/files/input/${encodeURIComponent(file.filename)}`;
    } else {
      if (!file.volumePath) throw new ComfyError("볼륨 경로가 없는 출력은 받을 수 없습니다", 404);
      path = `/files/output/${encodePath(file.volumePath)}`;
    }
    const res = await this.request(path, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    const size = Number(res.headers.get("content-length") ?? NaN);
    if (!res.body || (Number.isFinite(size) && size > MAX_OUTPUT_BYTES)) {
      await res.body?.cancel().catch(() => {});
      throw new ComfyError(
        res.body ? "출력 파일이 너무 큽니다" : "Modal 게이트웨이가 빈 응답을 보냈습니다",
      );
    }
    const declared = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const generic = !declared || declared === "application/octet-stream";
    return {
      body: res.body.pipeThrough(capBytes(MAX_OUTPUT_BYTES)),
      contentType: generic ? classifyOutput(file.filename).mime : res.headers.get("content-type"),
    };
  }

  /** Outputs are stored in the app now; the volume copies, the job record and progress can go. */
  async releaseOutputs(callId: string, files: OutputFile[]): Promise<void> {
    for (const f of files)
      if (f.volumePath)
        await this.request(`/files/output/${encodePath(f.volumePath)}`, { method: "DELETE" });
    await this.request(`/jobs/${encodeURIComponent(callId)}`, { method: "DELETE" });
  }
}

/** A volume path with each segment encoded and the separators kept. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** One snapshot per gateway for the process; validated against the gateway's ETag on each use. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis has no declared cache key; this file is its only reader and writer.
const globalForSnapshots = globalThis as unknown as {
  csModalObjectInfo?: Map<string, { etag: string | null; body: unknown }>;
};
function snapshotCache() {
  globalForSnapshots.csModalObjectInfo ??= new Map();
  return globalForSnapshots.csModalObjectInfo;
}
