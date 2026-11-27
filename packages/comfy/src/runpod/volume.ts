import { safeKey } from "../support/keys.ts";
import { EMPTY_PAYLOAD_HASH, sha256Hex, signRequest, uriEncode } from "../support/sigv4.ts";

/**
 * A RunPod network volume reached over its S3-compatible API: the worker's `input/`, `output/`
 * and `meta/` folders. Separate from `lib/storage` (the app's own asset storage): this client
 * reads what the worker wrote and needs LIST, and its credentials belong to a server row, not
 * to the deployment.
 */
export interface VolumeConfig {
  /** `https://s3api-<datacenter>.runpod.io`, no bucket in it. */
  endpoint: string;
  /** Datacenter id as RunPod spells it (`EU-RO-1`); used as the SigV4 region. */
  region: string;
  /** The network volume id — RunPod serves each volume as a bucket. */
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** A failed volume request. `status` is 0 when the endpoint could not be reached. */
export class VolumeError extends Error {
  status: number;
  code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "VolumeError";
  }
}

export interface VolumeObject {
  key: string;
  size: number;
  lastModified: Date | null;
}

export interface VolumeHead {
  etag: string | null;
  size: number | null;
  contentType: string | null;
}

/** Metadata requests (HEAD, DELETE, LIST) are small; an endpoint that takes longer is down. */
const METADATA_TIMEOUT_MS = 30_000;
/** One output file (a long video) may take a while to stream. */
const DOWNLOAD_TIMEOUT_MS = 180_000;
const LIST_PAGE_SIZE = 1000;
/** Pages a LIST may span before we stop (the input folder is not meant to hold that much). */
const MAX_LIST_PAGES = 20;

interface SendOptions {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: Uint8Array;
  timeoutMs?: number;
}

export class VolumeClient {
  private readonly config: VolumeConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: VolumeConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  /** Path-style object URL (`endpoint/bucket/key`), or the bucket's when `key` is null. */
  url(key: string | null, query?: Record<string, string>): URL {
    const url = new URL(this.config.endpoint);
    const base = url.pathname.replace(/\/+$/, "");
    const objectPath = key === null ? "" : `/${uriEncode(volumeKey(key), true)}`;
    url.pathname = `${base}/${uriEncode(this.config.bucket)}${objectPath}`;
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url;
  }

  private async send(method: string, key: string | null, opts: SendOptions = {}) {
    const url = this.url(key, opts.query);
    const headers = signRequest({
      method,
      url,
      headers: opts.headers ?? {},
      payloadHash: opts.body ? sha256Hex(opts.body) : EMPTY_PAYLOAD_HASH,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
    });
    if (opts.body) headers["content-length"] = String(opts.body.byteLength);
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fetch's BodyInit wants an ArrayBuffer-backed view; the bodies this client sends are never SharedArrayBuffer-backed.
        body: opts.body as Uint8Array<ArrayBuffer> | undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? METADATA_TIMEOUT_MS),
        redirect: "manual",
        cache: "no-store",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new VolumeError(0, null, `볼륨 스토리지에 연결할 수 없습니다 (${url.host}): ${reason}`);
    }
  }

  private async fail(res: Response, method: string, key: string | null): Promise<never> {
    const text = method === "HEAD" ? "" : await res.text().catch(() => "");
    const code =
      /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? (res.status === 404 ? "NoSuchKey" : null);
    if (res.status === 401 || res.status === 403)
      throw new VolumeError(res.status, code, "볼륨 S3 인증에 실패했습니다. S3 키를 확인하세요");
    throw new VolumeError(
      res.status,
      code,
      `볼륨 요청 실패: ${method} ${key ?? "(bucket)"} → ${res.status}${code ? ` ${code}` : ""}`,
    );
  }

  /** Streams an object. A missing key is a `VolumeError` with status 404. */
  async getStream(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string | null;
    size: number | null;
  }> {
    const res = await this.send("GET", key, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (!res.ok) await this.fail(res, "GET", key);
    const length = Number(res.headers.get("content-length"));
    return {
      body: res.body ?? new Response(new Uint8Array()).body!,
      contentType: res.headers.get("content-type"),
      size: Number.isFinite(length) && res.headers.has("content-length") ? length : null,
    };
  }

  async getBytes(key: string): Promise<Buffer> {
    const res = await this.send("GET", key, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (!res.ok) await this.fail(res, "GET", key);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Parses a JSON object; `null` when the key does not exist. */
  async getJson(key: string): Promise<unknown> {
    let bytes: Buffer;
    try {
      bytes = await this.getBytes(key);
    } catch (err) {
      if (err instanceof VolumeError && err.status === 404) return null;
      throw err;
    }
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new VolumeError(200, null, `볼륨의 ${key} 가 JSON이 아닙니다`);
    }
  }

  /** Object metadata, or null when the key does not exist. */
  async head(key: string): Promise<VolumeHead | null> {
    const res = await this.send("HEAD", key);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, "HEAD", key);
    await res.body?.cancel();
    const length = Number(res.headers.get("content-length"));
    return {
      etag: res.headers.get("etag"),
      size: res.headers.has("content-length") && Number.isFinite(length) ? length : null,
      contentType: res.headers.get("content-type"),
    };
  }

  async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
    const res = await this.send("PUT", key, {
      headers: contentType ? { "content-type": contentType } : {},
      body: data,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    if (!res.ok) await this.fail(res, "PUT", key);
    await res.body?.cancel();
  }

  /** Deleting a missing key is not an error (S3 itself answers 204 either way). */
  async delete(key: string): Promise<void> {
    const res = await this.send("DELETE", key);
    if (!res.ok && res.status !== 404) await this.fail(res, "DELETE", key);
    await res.body?.cancel();
  }

  /**
   * Objects under `prefix` (ListObjectsV2), following continuation tokens. With `shallow`,
   * only direct children: nested "folders" are left out, as the worker's input check wants.
   */
  async list(prefix: string, opts: { shallow?: boolean } = {}): Promise<VolumeObject[]> {
    const out: VolumeObject[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await this.send("GET", null, {
        query: {
          "list-type": "2",
          prefix,
          "max-keys": String(LIST_PAGE_SIZE),
          ...(opts.shallow ? { delimiter: "/" } : {}),
          ...(token ? { "continuation-token": token } : {}),
        },
      });
      if (!res.ok) await this.fail(res, "LIST", prefix);
      const parsed = parseListXml(await res.text());
      out.push(...parsed.objects);
      if (!parsed.truncated || !parsed.next) break;
      token = parsed.next;
    }
    return out;
  }
}

/**
 * A key as the worker would see it: relative, forward slashes, no `.`/`..` segments. Stricter
 * than `safeKey` (which rewrites a leading `..`): anything odd is refused, never repaired.
 */
export function volumeKey(key: string): string {
  const parts = key.split("/");
  if (
    !key ||
    key.startsWith("/") ||
    // oxlint-disable-next-line eslint/no-control-regex -- refuses backslashes and ASCII control characters in volume keys.
    /[\\\x00-\x1f]/.test(key) ||
    parts.some((p) => p === "" || p === "." || p === "..")
  )
    throw new VolumeError(400, null, `올바르지 않은 볼륨 경로입니다: ${key}`);
  return safeKey(key);
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return m ? xmlUnescape(m[1]!) : null;
}

/** The parts of a ListObjectsV2 result we use. No XML library: the shape is fixed and flat. */
export function parseListXml(xml: string): {
  objects: VolumeObject[];
  truncated: boolean;
  next: string | null;
} {
  const objects: VolumeObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1]!;
    const key = tag(block, "Key");
    if (!key) continue;
    const modified = tag(block, "LastModified");
    const date = modified ? new Date(modified) : null;
    objects.push({
      key,
      size: Number(tag(block, "Size") ?? 0) || 0,
      lastModified: date && !Number.isNaN(date.getTime()) ? date : null,
    });
  }
  return {
    objects,
    truncated: tag(xml, "IsTruncated") === "true",
    next: tag(xml, "NextContinuationToken"),
  };
}
