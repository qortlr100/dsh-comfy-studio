/**
 * The HTTP routes of the asset component, registered as dsh Connection Fetch routes (only the owner reaches them):
 * the file route (with single-range support), the thumbnail route, the upload route, which stores the bytes and runs
 * `asset.import` as the user, and the stage route, which only stores the bytes.
 *
 * Only the kinds of file a page may draw are served under their own type; everything else, HTML and SVG included, is
 * served as an attachment of type `application/octet-stream`, so no script of an uploaded file runs on this origin.
 *
 * @module @cs/asset/routes
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import {
  ProjectError,
  type AssetId,
  type ProjectId,
  type RecordId,
  type RunRequest,
  type RunResult,
  type SessionId,
} from "@cs/project";
import type { AssetFiles } from "./store.ts";
import type { Thumbnails } from "./thumbs.ts";
import { ASSET_OPERATIONS, ASSET_ROUTES } from "./types.ts";

/** Media types a page may draw, served as they are. */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/flac",
  "audio/ogg",
  "audio/opus",
  "audio/mp4",
  "audio/aac",
]);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
} as const;
const IMMUTABLE = "private, max-age=31536000, immutable";
const ASSET_ID = /^[0-9a-f]{64}$/;
const MIME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const NAME_LIMIT = 200;

/** The HTTP status of each refused Project call that a browser request can cause; any other code answers 409. */
const STATUS_OF: Partial<Record<ProjectError["code"], 400 | 404>> = {
  unknown_project: 404,
  unknown_record: 404,
  unknown_operation: 404,
  unknown_asset: 404,
  invalid_params: 400,
  invalid_inputs: 400,
  input_not_ready: 400,
};

/** What the routes ask of the host. */
export interface RouteDeps {
  files: Pick<AssetFiles, "find" | "path" | "beginUpload" | "commitUpload" | "discardUpload">;
  thumbs: Pick<Thumbnails, "thumbOf">;
  project: {
    openProject(project: ProjectId): unknown;
    run(request: RunRequest): Promise<RunResult>;
  };
  /** Add the media facts ffprobe reads to an imported asset; best effort, never throws. */
  probe(asset: AssetId): Promise<void>;
  /** The most bytes an upload may carry. */
  maxUploadBytes: number;
  /** Told about a failure answered with 500. */
  onInternalError: (error: unknown) => void;
}

/** A refusal with its status and code. */
class RouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "RouteError";
  }
}

/**
 * @param value - a JSON value.
 * @param status - the HTTP status.
 * @returns a JSON response that is not cached.
 */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * @param error - what a route threw.
 * @param onInternalError - told about an unexpected failure.
 * @returns the error response `{error, code}` of every `/api/cs` route.
 */
function failure(error: unknown, onInternalError: (error: unknown) => void): Response {
  if (error instanceof RouteError)
    return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof ProjectError) {
    return json({ error: error.message, code: error.code }, STATUS_OF[error.code] ?? 409);
  }
  onInternalError(error);
  return json({ error: "The asset route failed.", code: "internal_error" }, 500);
}

/**
 * @param request - a request.
 * @returns the asset the `id` query names.
 * @throws RouteError `invalid_params` for a missing or malformed ID.
 */
function assetIdOf(request: Request): AssetId {
  const value = new URL(request.url).searchParams.get("id");
  if (value === null || !ASSET_ID.test(value))
    throw new RouteError(400, "'id' must name an asset.", "invalid_params");
  return brandString<AssetId>(value);
}

/**
 * @param name - a file name.
 * @returns the name as an RFC 5987 value for `filename*`.
 */
function encodeName(name: string): string {
  // A lone surrogate makes `encodeURIComponent` throw; it becomes U+FFFD first.
  return encodeURIComponent(name.toWellFormed()).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The byte range a `Range` header asks for.
 * @param header - the header value, or null when absent.
 * @param size - the file size.
 * @returns `null` to serve the whole file (no header, or several ranges, which are not honoured), `"unsatisfiable"` for
 *   a malformed range or one outside the file, else the first and last byte.
 */
function rangeOf(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (header === null) return null;
  if (header.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return "unsatisfiable";
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return "unsatisfiable";
  if (from === "") {
    const last = Number(to);
    if (last === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? "unsatisfiable" : { start, end };
}

/**
 * @param path - a file.
 * @param range - the first and last byte, or null for all.
 * @returns a streaming body.
 */
function streamOf(path: string, range: { start: number; end: number } | null): ReadableStream {
  const stream = createReadStream(
    path,
    range === null ? {} : { start: range.start, end: range.end },
  );
  // Node's web stream and the DOM-free Response body type name the same object.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Readable.toWeb yields a WHATWG ReadableStream
  return Readable.toWeb(stream) as ReadableStream;
}

/**
 * @param path - a file.
 * @returns its size, or null when it does not exist.
 */
async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Serve the bytes of an asset. */
async function serveFile(deps: RouteDeps, request: Request): Promise<Response> {
  const asset = assetIdOf(request);
  const entry = deps.files.find(asset);
  if (entry === undefined) throw new RouteError(404, `Unknown asset '${asset}'.`, "unknown_asset");
  const path = deps.files.path(asset);
  // The file on disk is the truth: an object that was removed answers 404 instead of a stream that breaks.
  const size = await sizeOf(path);
  if (size === null) throw new RouteError(404, `Unknown asset '${asset}'.`, "unknown_asset");
  const mime = entry.mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const inline = INLINE_TYPES.has(mime);
  const download = new URL(request.url).searchParams.get("download") === "1";
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "cache-control": IMMUTABLE,
    "accept-ranges": "bytes",
    "content-type": inline ? mime : "application/octet-stream",
  };
  if (!inline || download)
    headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeName(entry.name)}`;
  const range = rangeOf(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${String(size)}` },
    });
  }
  const head = request.method === "HEAD";
  if (range === null) {
    headers["content-length"] = String(size);
    return new Response(head ? null : streamOf(path, null), { status: 200, headers });
  }
  headers["content-length"] = String(range.end - range.start + 1);
  headers["content-range"] = `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`;
  return new Response(head ? null : streamOf(path, range), { status: 206, headers });
}

/** Serve the thumbnail of an asset. */
async function serveThumb(deps: RouteDeps, request: Request): Promise<Response> {
  const asset = assetIdOf(request);
  if (deps.files.find(asset) === undefined)
    throw new RouteError(404, `Unknown asset '${asset}'.`, "unknown_asset");
  const path = await deps.thumbs.thumbOf(asset);
  const size = path === null ? null : await sizeOf(path);
  if (path === null || size === null)
    throw new RouteError(404, `Asset '${asset}' has no thumbnail.`, "no_thumbnail");
  return new Response(request.method === "HEAD" ? null : streamOf(path, null), {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "cache-control": IMMUTABLE,
      "content-type": "image/webp",
      "content-length": String(size),
    },
  });
}

/**
 * @param name - a file name.
 * @returns whether it holds a control character or a path separator.
 */
function hasForbiddenCharacter(name: string): boolean {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 32 || code === 127 || code === 47 || code === 92) return true;
  }
  return false;
}

/** What an upload names. */
interface UploadParams {
  project: ProjectId;
  name: string;
  mime: string;
}

/**
 * @param request - an upload or stage request.
 * @param deps - the route dependencies.
 * @returns the validated query.
 * @throws RouteError `invalid_params` (400); ProjectError `unknown_project`.
 */
function uploadParamsOf(request: Request, deps: RouteDeps): UploadParams {
  const query = new URL(request.url).searchParams;
  const project = query.get("project");
  if (project === null || project === "")
    throw new RouteError(400, "'project' must name a project.", "invalid_params");
  const name = query.get("name");
  if (name === null || name.length < 1 || name.length > NAME_LIMIT || hasForbiddenCharacter(name)) {
    throw new RouteError(
      400,
      `'name' must be 1 to ${String(NAME_LIMIT)} characters without control characters or path separators.`,
      "invalid_params",
    );
  }
  const mime = query.get("mime");
  if (mime === null || !MIME_SHAPE.test(mime)) {
    throw new RouteError(400, "'mime' must be a media type such as image/png.", "invalid_params");
  }
  const id = brandString<ProjectId>(project);
  deps.project.openProject(id);
  return { project: id, name, mime };
}

/**
 * Stream an upload body into a partial file of the project's own `objects` directory while hashing it, then give it its
 * content address; the partial file is removed in every failure case. Nothing reads the file back.
 * @param request - the request.
 * @param deps - the route dependencies.
 * @param params - the validated query.
 * @returns the asset ID.
 * @throws RouteError `payload_too_large` (413) over the limit.
 */
async function storeUpload(
  request: Request,
  deps: RouteDeps,
  params: UploadParams,
): Promise<AssetId> {
  const tooLarge = (): RouteError =>
    new RouteError(
      413,
      `The upload is larger than ${String(deps.maxUploadBytes)} bytes.`,
      "payload_too_large",
    );
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > deps.maxUploadBytes) throw tooLarge();
  const partial = deps.files.beginUpload(params.project);
  try {
    const hash = createHash("sha256");
    let total = 0;
    const file = await open(partial, "w");
    try {
      if (request.body !== null) {
        const reader = request.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            // The rest of the body is discarded by `receive`, so the answer reaches the client.
            if (total > deps.maxUploadBytes) throw tooLarge();
            hash.update(value);
            let offset = 0;
            while (offset < value.byteLength) {
              const { bytesWritten } = await file.write(value, offset);
              offset += bytesWritten;
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
    } finally {
      await file.close();
    }
    return deps.files.commitUpload(
      params.project,
      partial,
      { id: brandString<AssetId>(hash.digest("hex")), size: total },
      { mime: params.mime, name: params.name },
      null,
    );
  } catch (error) {
    deps.files.discardUpload(partial);
    throw error;
  }
}

/**
 * Run an operation as the user and return its result.
 * @param deps - the route dependencies.
 * @param request - the call, without the origin.
 * @param origin - the surface and session of the call.
 * @returns the result.
 */
async function runAsUser(
  deps: RouteDeps,
  request: {
    project: ProjectId;
    operation: string;
    params: Record<string, unknown>;
    asset: AssetId;
    role: string;
  },
  origin: { surface: "chat" | "view"; session: SessionId | null; intent: string },
): Promise<RunResult> {
  return deps.project.run({
    project: request.project,
    operation: request.operation,
    params: request.params,
    inputs: [{ role: request.role, ref: { asset: request.asset } }],
    actor: "user",
    surface: origin.surface,
    session: origin.session,
    turn: null,
    tool_call: null,
    intent: origin.intent,
  });
}

/**
 * Read and discard what is left of a request body. dsh closes the connection of a streaming route whose handler
 * answered before the body ended (upstream `packages/client/connection/src/http-bridge.ts` at dsh-v0.2.2-rc.5), and a
 * browser that is still sending then reports a network failure instead of the answer. So a refusal reads the body to
 * its end first; past `limit` more bytes it gives up and lets the connection close.
 * @param request - the request.
 * @param limit - the most bytes to discard.
 */
async function discardBody(request: Request, limit: number): Promise<void> {
  if (request.body === null || request.body.locked) return;
  const reader = request.body.getReader();
  try {
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
      if (total > limit) return;
    }
  } catch {
    // The client went away; there is no one to answer.
  } finally {
    reader.releaseLock();
  }
}

/** Store the bytes of an upload; answers the asset and, for an upload, the import's record. */
async function receive(deps: RouteDeps, request: Request, library: boolean): Promise<Response> {
  try {
    return await receiveBody(deps, request, library);
  } catch (error) {
    await discardBody(request, deps.maxUploadBytes);
    throw error;
  }
}

/** {@link receive} without the handling of a refusal. */
async function receiveBody(deps: RouteDeps, request: Request, library: boolean): Promise<Response> {
  const params = uploadParamsOf(request, deps);
  const query = new URL(request.url).searchParams;
  const asset = await storeUpload(request, deps, params);
  await deps.probe(asset);
  if (!library) return json({ asset });
  const origin = {
    surface: query.get("surface") === "chat" ? ("chat" as const) : ("view" as const),
    session:
      query.get("session") === null || query.get("session") === ""
        ? null
        : brandString<SessionId>(query.get("session") ?? ""),
    intent: `upload ${params.name}`,
  };
  const imported = await runAsUser(
    deps,
    {
      project: params.project,
      operation: ASSET_OPERATIONS.import,
      params: {},
      asset,
      role: "file",
    },
    origin,
  );
  const folder = query.get("folder");
  if (folder !== null && folder !== "") {
    await runAsUser(
      deps,
      {
        project: params.project,
        operation: ASSET_OPERATIONS.move,
        params: { folder: brandString<RecordId>(folder) },
        asset,
        role: "asset",
      },
      origin,
    );
  }
  return json({ asset, record: imported.record });
}

/**
 * @param deps - what the routes need.
 * @returns the Fetch routes of {@link ASSET_ROUTES}, for the Connection to register.
 */
export function assetRoutes(deps: RouteDeps): ConnectionFetchRoute[] {
  const guarded =
    (run: (request: Request) => Response | Promise<Response>) => async (request: Request) => {
      try {
        return await run(request);
      } catch (error) {
        return failure(error, deps.onInternalError);
      }
    };
  return [
    {
      path: ASSET_ROUTES.file,
      methods: ["GET", "HEAD"],
      requestBody: "buffered",
      fetch: guarded((request) => serveFile(deps, request)),
    },
    {
      path: ASSET_ROUTES.thumb,
      methods: ["GET", "HEAD"],
      requestBody: "buffered",
      fetch: guarded((request) => serveThumb(deps, request)),
    },
    {
      path: ASSET_ROUTES.upload,
      methods: ["POST"],
      requestBody: "streaming",
      fetch: guarded((request) => receive(deps, request, true)),
    },
    {
      path: ASSET_ROUTES.stage,
      methods: ["POST"],
      requestBody: "streaming",
      fetch: guarded((request) => receive(deps, request, false)),
    },
  ];
}
