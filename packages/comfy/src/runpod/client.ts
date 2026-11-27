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
import {
  parseJobOutput,
  parseJobRecord,
  parseJobStatus,
  parseRunResponse,
  type JobState,
} from "./protocol.ts";
import { hasUploadInput, inputFileNames, pickNodeInfo, withInputFiles } from "./object-info.ts";
import { VolumeClient, VolumeError, type VolumeConfig } from "./volume.ts";

/** What the client needs to reach one RunPod Serverless endpoint. Keys are already decrypted. */
export interface RunPodConfig {
  /** `https://api.runpod.ai/v2/<endpoint id>` */
  baseUrl: string;
  /** RunPod API key (bearer). */
  apiKey: string;
  /** The endpoint's network volume, where the worker reads inputs and leaves outputs. */
  volume: VolumeConfig;
}

/** RunPod's job API root; the form turns an endpoint id into `base_url` with it. */
export const RUNPOD_API_ROOT = "https://api.runpod.ai/v2";

/** Where the worker image writes on the volume. */
export const META_OBJECT_INFO_KEY = "meta/object_info.json";
export const META_WORKER_KEY = "meta/worker.json";

const DEFAULT_TIMEOUT_MS = 15_000;

const healthSchema = z
  .object({
    jobs: z.record(z.string(), z.number()).optional(),
    workers: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();

/** `meta/worker.json` as the worker writes it on start. */
const workerMetaSchema = z
  .object({
    image: z.string().nullish(),
    comfyui_version: z.string().nullish(),
    devices: z.array(z.string().nullable()).optional(),
    written_at: z.string().nullish(),
  })
  .passthrough();

/**
 * Backend for a RunPod Serverless endpoint running the comfy worker. Jobs go through RunPod's
 * queue API (`/run`, `/status`, `/cancel`, `/health`) with the RunPod API key; files go through
 * the endpoint's network volume over S3 (`VolumeClient`), where the worker reads `input/` and
 * writes `output/` and `meta/`. There is no ComfyUI HTTP or WebSocket to talk to.
 */
export class RunPodClient implements ComfyBackend {
  readonly volume: VolumeClient;
  private readonly root: string;
  private readonly cfg: RunPodConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: RunPodConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.root = cfg.baseUrl.replace(/\/+$/, "");
    this.volume = new VolumeClient(cfg.volume, fetchImpl);
  }

  /** One job API call. Auth failures and non-2xx answers become `ComfyError`s. */
  private async api(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.root}${path}`, {
        ...rest,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- callers in this library only pass plain header records; Headers would lowercase the keys.
          ...(rest.headers as Record<string, string> | undefined),
        },
        signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
        throw new ComfyError("RunPod API 응답 시간이 초과되었습니다");
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
      throw new ComfyError(`RunPod API에 연결할 수 없습니다${cause ? ` (${cause})` : ""}`);
    }
    if (res.status === 401 || res.status === 403)
      throw new ComfyError("RunPod 인증에 실패했습니다. API 키를 확인하세요", res.status);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* Non-JSON error pages fall through to the status check. */
    }
    if (!res.ok) {
      const message =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : `RunPod 요청 실패 (${res.status} ${res.statusText})`;
      throw new ComfyError(message, res.status);
    }
    return body;
  }

  /**
   * `/health` proves the API key and the endpoint; `meta/worker.json` proves the volume key and
   * tells which image the worker last ran. Worker counts go into `note` for the server card.
   */
  async systemStats(): Promise<SystemStats> {
    const health = healthSchema.safeParse(await this.api("/health"));
    if (!health.success) throw new ComfyError("RunPod 응답 형식이 아닙니다 (/health)");
    let meta: z.infer<typeof workerMetaSchema> | null = null;
    try {
      const raw = await this.volume.getJson(META_WORKER_KEY);
      const parsed = workerMetaSchema.safeParse(raw);
      meta = raw === null ? null : parsed.success ? parsed.data : null;
    } catch (err) {
      throw fromVolumeError(err);
    }
    const workers = health.data.workers ?? {};
    const jobs = health.data.jobs ?? {};
    const parts = [
      `워커 대기 ${workers.idle ?? 0} · 실행 ${workers.running ?? 0}`,
      workers.initializing ? `초기화 ${workers.initializing}` : null,
      workers.unhealthy ? `비정상 ${workers.unhealthy}` : null,
      `작업 큐 ${jobs.inQueue ?? 0} · 진행 ${jobs.inProgress ?? 0}`,
      meta?.image ? `이미지 ${meta.image}` : "볼륨에 워커 기록 없음(첫 실행 뒤 생김)",
    ];
    return {
      comfyuiVersion: meta?.comfyui_version ?? null,
      pythonVersion: null,
      os: null,
      devices: (meta?.devices ?? [])
        .filter((d): d is string => typeof d === "string" && d.length > 0)
        .map((name) => ({ name, type: "cuda", vramTotal: null, vramFree: null })),
      note: parts.filter((p): p is string => !!p).join(" · "),
    };
  }

  /** `POST /run` with the graph as the handler's `workflow`. Validation errors surface later, as a FAILED job. */
  async queuePrompt(graph: ApiGraph): Promise<string> {
    const body = await this.api("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { workflow: graph } }),
      timeoutMs: 60_000,
    });
    const id = parseRunResponse(body);
    if (!id) throw new ComfyError("RunPod가 작업 id를 돌려주지 않았습니다");
    return id;
  }

  /**
   * `GET /status/{id}`. While the job runs, the handler's progress rides along; once it is done,
   * its result does — for about 30 minutes, after which (or on a 404) the handler's own record
   * on the volume (`output/_jobs/<id>.json`) stands in.
   */
  async result(jobId: string): Promise<HistoryResult> {
    let state: JobState | null;
    try {
      state = parseJobStatus(await this.api(`/status/${encodeURIComponent(jobId)}`));
      if (!state) throw new ComfyError("RunPod 응답 형식이 아닙니다 (/status)");
    } catch (err) {
      if (!(err instanceof ComfyError && err.status === 404)) throw err;
      state = { status: "completed", output: null };
    }
    switch (state.status) {
      case "pending":
        return { state: "pending", progress: state.progress };
      case "failed":
        return { state: "failed", error: state.error };
      case "cancelled":
        return { state: "interrupted" };
      default: {
        const output = state.output ?? (await this.jobRecord(jobId));
        if (output === null)
          return {
            state: "failed",
            error:
              "RunPod가 결과를 더 보관하지 않고 볼륨에도 작업 기록이 없어 결과를 받을 수 없습니다",
          };
        const parsed = parseJobOutput(output);
        if (parsed.kind === "failed") return { state: "failed", error: parsed.error };
        for (const w of parsed.warnings) console.warn(`[runpod] ${jobId}: ${w}`);
        return { state: "succeeded", files: parsed.files };
      }
    }
  }

  private async jobRecord(jobId: string): Promise<unknown> {
    try {
      const body = await this.volume.getJson(jobRecordKey(jobId));
      return body === null ? null : parseJobRecord(body);
    } catch (err) {
      throw fromVolumeError(err);
    }
  }

  /**
   * `POST /cancel/{id}`, then the status says what happened. RunPod cancels the job at once (the
   * worker stops the orphaned prompt when its next job starts), so "still running" is rare.
   */
  async cancel(jobId: string): Promise<CancelOutcome> {
    const id = encodeURIComponent(jobId);
    await this.api(`/cancel/${id}`, { method: "POST" });
    const state = parseJobStatus(await this.api(`/status/${id}`));
    if (!state) throw new ComfyError("RunPod 응답 형식이 아닙니다 (/status)");
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
   * Node definitions from the worker's snapshot on the volume (`meta/object_info.json`, written
   * when the worker starts, so it reflects the image and the volume's models), cached by ETag.
   * Image inputs get the live `input/` listing instead of the snapshot's. Without a snapshot the
   * fields fall back to inference (the caller catches), which is the case until the worker's
   * first run.
   */
  async objectInfo(classes: string[]): Promise<ObjectInfo> {
    try {
      return await this.withLiveInputs(pickNodeInfo(await this.requireSnapshot(), classes));
    } catch (err) {
      throw fromVolumeError(err);
    }
  }

  /** The whole snapshot, upload inputs (image, audio, video) listed live, like `objectInfo` for every class. */
  async listNodeClasses(): Promise<ObjectInfo> {
    try {
      return await this.withLiveInputs(parseObjectInfo(await this.requireSnapshot()));
    } catch (err) {
      throw fromVolumeError(err);
    }
  }

  private async requireSnapshot(): Promise<unknown> {
    const snapshot = await this.snapshot();
    if (snapshot === null)
      throw new ComfyError(
        "볼륨에 노드 정보 스냅샷(meta/object_info.json)이 없습니다. 워커가 한 번 실행되면 생깁니다",
        404,
      );
    return snapshot;
  }

  private async withLiveInputs(info: ObjectInfo): Promise<ObjectInfo> {
    if (!hasUploadInput(info)) return info;
    const files = await this.volume.list("input/", { shallow: true });
    return withInputFiles(info, inputFileNames(files.map((f) => f.key)));
  }

  /** The parsed snapshot, re-read only when its ETag changed; null when the volume has none. */
  private async snapshot(): Promise<unknown> {
    const head = await this.volume.head(META_OBJECT_INFO_KEY);
    if (!head) return null;
    const cacheKey = `${this.cfg.volume.endpoint}/${this.cfg.volume.bucket}`;
    const cached = snapshotCache().get(cacheKey);
    if (cached && head.etag && cached.etag === head.etag) return cached.body;
    const body = await this.volume.getJson(META_OBJECT_INFO_KEY);
    if (body === null) return null;
    snapshotCache().set(cacheKey, { etag: head.etag, body });
    return body;
  }

  /**
   * Puts the image at the top of `input/`, where the handler checks for it before queuing (no
   * subfolders there). S3 overwrites silently, so the name gets a short unique suffix; the
   * returned name is the field value.
   */
  async uploadImage(file: Blob, filename: string): Promise<string> {
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    const name = `${stem}-${shortId(6)}${ext}`;
    try {
      await this.volume.put(`input/${name}`, new Uint8Array(await file.arrayBuffer()), file.type);
    } catch (err) {
      throw fromVolumeError(err);
    }
    return name;
  }

  /**
   * Streams a file from the volume: an output by the path the handler reported, or an input
   * (`type: "input"`) by name from `input/`. The volume may not know media types, so the name
   * decides when it does not.
   */
  async view(
    file: ViewRef,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null }> {
    let key: string;
    if (file.type === "input") {
      if (file.subfolder) throw new ComfyError("볼륨 입력은 하위 폴더를 쓰지 않습니다", 404);
      key = `input/${file.filename}`;
    } else {
      if (!file.volumePath) throw new ComfyError("볼륨 경로가 없는 출력은 받을 수 없습니다", 404);
      key = `output/${file.volumePath}`;
    }
    try {
      const got = await this.volume.getStream(key);
      if (got.size !== null && got.size > MAX_OUTPUT_BYTES) {
        await got.body.cancel().catch(() => {});
        throw new ComfyError("출력 파일이 너무 큽니다");
      }
      const declared = got.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
      const generic =
        !declared || declared === "application/octet-stream" || declared === "binary/octet-stream";
      return {
        body: got.body.pipeThrough(capBytes(MAX_OUTPUT_BYTES)),
        contentType: generic ? classifyOutput(file.filename).mime : got.contentType,
      };
    } catch (err) {
      throw fromVolumeError(err);
    }
  }

  /** Outputs are stored in the app now; the volume copies and the job record can go. */
  async releaseOutputs(jobId: string, files: OutputFile[]): Promise<void> {
    try {
      for (const f of files) if (f.volumePath) await this.volume.delete(`output/${f.volumePath}`);
      await this.volume.delete(jobRecordKey(jobId));
    } catch (err) {
      throw fromVolumeError(err);
    }
  }
}

/** Where the handler leaves a job's result for clients that come late. */
export function jobRecordKey(jobId: string): string {
  return `output/_jobs/${jobId}.json`;
}

/** One snapshot per volume for the process; validated against the object's ETag on each use. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis has no declared cache key; this file is its only reader and writer.
const globalForSnapshots = globalThis as unknown as {
  csRunpodObjectInfo?: Map<string, { etag: string | null; body: unknown }>;
};
function snapshotCache() {
  globalForSnapshots.csRunpodObjectInfo ??= new Map();
  return globalForSnapshots.csRunpodObjectInfo;
}

/** Volume failures surface to callers as the one error type they handle. */
export function fromVolumeError(err: unknown): unknown {
  return err instanceof VolumeError ? new ComfyError(err.message, err.status || undefined) : err;
}
