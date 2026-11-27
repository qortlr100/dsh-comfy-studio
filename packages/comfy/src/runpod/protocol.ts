import { z } from "zod";
import type { OutputFile, PolledProgress } from "../protocol.ts";

/**
 * Parsers for RunPod's job API (`/run`, `/status/{id}`) and for what the comfy worker's handler
 * returns as a job's `output`. The Modal gateway answers in the same shapes, so `label` names the
 * platform in fallback messages. Pure; shapes are narrowed with zod and anything unexpected is
 * ignored rather than trusted.
 */

/** `/status/{id}` as this app sees it; the client turns it into a `HistoryResult`. */
export type JobState =
  | { status: "pending"; progress: PolledProgress | null }
  /** Done; `output` is the handler's result, or null when RunPod no longer has it. */
  | { status: "completed"; output: unknown }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

/** The handler's result for a job that ran. */
export interface JobOutput {
  files: OutputFile[];
  /** Non-fatal notes the handler added (`errors` list), for the log. */
  warnings: string[];
}

const runResponseSchema = z.object({ id: z.string().min(1) }).passthrough();

const statusSchema = z
  .object({
    id: z.string().optional(),
    status: z.string(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const progressSchema = z
  .object({
    node: z.union([z.string(), z.number()]).nullish(),
    value: z.number().nullish(),
    max: z.number().nullish(),
  })
  .passthrough();

/** One entry of the handler's `images` list (every output key lands there, videos included). */
const outputItemSchema = z
  .object({
    node_id: z.union([z.string(), z.number()]),
    filename: z.string().min(1),
    subfolder: z.string().optional().default(""),
    type: z.string().optional().default("volume"),
    /** For `type: "volume"`, the path under the volume's `output/`. */
    data: z.string().optional(),
  })
  .passthrough();

const jobOutputSchema = z
  .object({
    images: z.array(z.unknown()).optional(),
    errors: z.array(z.unknown()).optional(),
    error: z.unknown().optional(),
    details: z.unknown().optional(),
  })
  .passthrough();

const jobRecordSchema = z.object({ id: z.string().optional(), output: z.unknown() }).passthrough();

export function parseRunResponse(body: unknown): string | null {
  const parsed = runResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.id : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

/** A readable message out of whatever the handler or RunPod put in `output`/`error`. */
export function errorMessageOf(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (c && typeof c === "object") {
      const main = str(Reflect.get(c, "error")) ?? str(Reflect.get(c, "message"));
      if (!main) continue;
      const rawDetails: unknown = Reflect.get(c, "details");
      const details =
        typeof rawDetails === "string"
          ? rawDetails
          : Array.isArray(rawDetails)
            ? rawDetails.map(String).join("; ")
            : null;
      return details ? `${main}: ${details}` : main;
    }
  }
  return null;
}

/**
 * Reads `/status/{id}`. `IN_PROGRESS` carries the handler's last `progress_update` payload in
 * `output`; `COMPLETED` carries the handler's result there (null once RunPod has forgotten it,
 * about 30 minutes after completion). `IN_PROGRESS` always yields a progress, empty when there
 * is no payload yet (or the worker predates progress reports), so the run shows as running
 * rather than queued once a worker has it.
 */
export function parseJobStatus(body: unknown, label = "RunPod"): JobState | null {
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success) return null;
  const { status, output, error } = parsed.data;
  switch (status.toUpperCase()) {
    case "IN_QUEUE":
      return { status: "pending", progress: null };
    case "IN_PROGRESS": {
      const p = progressSchema.safeParse(output);
      return {
        status: "pending",
        progress: p.success
          ? { node: str(p.data.node), value: p.data.value ?? null, max: p.data.max ?? null }
          : { node: null, value: null, max: null },
      };
    }
    case "COMPLETED":
      return { status: "completed", output: output ?? null };
    case "FAILED":
      return {
        status: "failed",
        error: errorMessageOf(output, error) ?? `${label} 작업이 실패했습니다`,
      };
    case "TIMED_OUT":
      return {
        status: "failed",
        error: `${label} 실행 시간 제한을 넘겨 중단되었습니다 (TIMED_OUT)`,
      };
    case "CANCELLED":
    case "CANCELED":
      return { status: "cancelled" };
    default:
      return { status: "pending", progress: null };
  }
}

/**
 * The handler's result. A result with `error` is a failure (the SDK marks such jobs FAILED, but
 * a job record on the volume carries the dict as is). Only volume-backed files are usable here;
 * other kinds are noted and skipped.
 */
export function parseJobOutput(
  output: unknown,
  label = "RunPod",
): { kind: "failed"; error: string } | ({ kind: "succeeded" } & JobOutput) {
  const parsed = jobOutputSchema.safeParse(output);
  if (!parsed.success) return { kind: "failed", error: `${label} 작업 결과 형식이 아닙니다` };
  const failure = errorMessageOf(parsed.data.error !== undefined ? parsed.data : null);
  if (failure) return { kind: "failed", error: failure };
  const files: OutputFile[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.data.images ?? []) {
    const item = outputItemSchema.safeParse(raw);
    if (!item.success) continue;
    const { node_id, filename, subfolder, type, data } = item.data;
    if (type !== "volume" || !data) {
      warnings.push(`${filename}: 볼륨에 남지 않은 출력(${type})은 받을 수 없습니다`);
      continue;
    }
    const volumePath = data.replace(/\\/g, "/").replace(/^\/+/, "");
    const id = `${subfolder}/${filename}`;
    if (seen.has(id)) continue;
    seen.add(id);
    files.push({ nodeId: String(node_id), filename, subfolder, type: "output", volumePath });
  }
  for (const e of parsed.data.errors ?? []) {
    const message = errorMessageOf(e);
    if (message) warnings.push(message);
  }
  return { kind: "succeeded", files, warnings };
}

/** `output/_jobs/<id>.json` as the handler writes it: `{ id, finished_at, output }`. */
export function parseJobRecord(body: unknown): unknown {
  const parsed = jobRecordSchema.safeParse(body);
  return parsed.success && parsed.data.output !== undefined ? parsed.data.output : null;
}
