import type { ComfyServerKind } from "./types.ts";
import type { ApiGraph, ObjectInfo } from "./workflow.ts";
import type { HistoryResult, OutputFile, ServerRun } from "./protocol.ts";

/**
 * What the runner, the server routes and the input/workflow services need from a generation
 * backend, whatever speaks on the other side: a ComfyUI server (`ComfyClient`, local or Comfy
 * Cloud) or a job queue wrapping one (RunPod Serverless). `comfyClientFor()` /
 * `comfyBackendFor()` in `lib/comfy-servers.service` pick the implementation per server kind;
 * nothing else constructs one.
 */
export interface ComfyBackend {
  /** Connectivity check for the server card. Queues nothing. */
  systemStats(): Promise<SystemStats>;
  /** Node definitions for the given classes; unknown classes are simply absent. */
  objectInfo(classes: string[]): Promise<ObjectInfo>;
  /**
   * Every node class the server knows (the whole `/object_info`), for searching classes and
   * validating edited graphs. Megabytes: callers go through `lib/comfy/node-catalog.ts`.
   */
  listNodeClasses(): Promise<ObjectInfo>;
  /** Submits a graph and returns the id polled by `result()`. Validation failures throw. */
  queuePrompt(graph: ApiGraph, clientId: string): Promise<string>;
  /** Where the run stands, and its output files once it succeeded. */
  result(promptId: string): Promise<HistoryResult>;
  /**
   * Stops a run. `canceled`: it was still queued and is gone; `running`: an interrupt was sent
   * and `result()` decides the end state; `finished`: it ended on its own before the cancel, so
   * its results stand. Throws when the state cannot be told (the caller then keeps tracking).
   */
  cancel(promptId: string): Promise<CancelOutcome>;
  /** Puts a file where LoadImage-style nodes read it; returns the value for the field. */
  uploadImage(file: Blob, filename: string): Promise<string>;
  /** Streams an output (or, with `type: "input"`, an input) file. */
  view(file: ViewRef): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null }>;
  /** Live progress socket, for backends that have one. Progress is best effort either way. */
  openSocket?(clientId: string): WebSocket;
  /**
   * Called once every output of a finished run is stored, for backends that park outputs
   * somewhere they should not stay (a volume). Best effort: a failure here is only logged.
   */
  releaseOutputs?(promptId: string, files: OutputFile[]): Promise<void>;
  /**
   * The server's most recent finished runs (at most `limit`), newest first, each with the API
   * graph it ran — where a template is imported from (`importServerRun`). Only backends that
   * keep a history across runs have it: see `HISTORY_SERVER_KINDS`.
   */
  listHistory?(limit: number): Promise<ServerRun[]>;
  /**
   * File names in one model folder (`checkpoints`, `loras`, …) as a loader input takes them,
   * subfolders included. Only backends with a file listing have it: see `MODEL_META_SERVER_KINDS`.
   */
  listModels?(folder: string): Promise<string[]>;
  /**
   * The safetensors header `__metadata__` of one model file (string values only), or null when
   * the file has none (not a safetensors file, or an empty header). Same backends as `listModels`.
   */
  modelMetadata?(folder: string, file: string): Promise<Record<string, string> | null>;
}

/**
 * Server kinds whose backend implements `listModels` and `modelMetadata`: self-hosted ComfyUI
 * serves `/models/{folder}` and `/view_metadata/{folder}`. Elsewhere a model is known by the file
 * names its loaders list only. Shared with the browser (the server card's wording).
 */
export const MODEL_META_SERVER_KINDS: readonly ComfyServerKind[] = ["local"];

/**
 * Server kinds whose backend implements `listHistory`. Self-hosted ComfyUI keeps `/history`;
 * serverless workers start fresh every time, and Comfy Cloud waits on confirming its list
 * endpoint. Shared with the browser, which only offers these servers for importing a run.
 */
export const HISTORY_SERVER_KINDS: readonly ComfyServerKind[] = ["local"];

export type CancelOutcome = "canceled" | "running" | "finished";

/** What `view` needs: an `OutputFile` minus the node, or an input by name. */
export type ViewRef = Pick<OutputFile, "filename" | "subfolder" | "type" | "volumePath">;

/** A failure talking to the backend, with a message fit for the UI. */
export class ComfyError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface SystemStats {
  comfyuiVersion: string | null;
  pythonVersion: string | null;
  os: string | null;
  devices: { name: string; type: string; vramTotal: number | null; vramFree: number | null }[];
  /** Backend-specific summary for the server card (e.g. RunPod worker counts and image). */
  note?: string;
}

/** Upper bound for one output file pulled from a backend. */
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/** Passes bytes through and fails the stream once more than `limit` bytes went by. */
export function capBytes(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) controller.error(new ComfyError("출력 파일이 너무 큽니다"));
      else controller.enqueue(chunk);
    },
  });
}
