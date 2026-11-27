import { createHash, createHmac } from "node:crypto";

/** Payload hash for bodies that are not hashed up front (streamed uploads); S3 accepts it over TLS or not. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** SHA-256 of an empty body, for GET/HEAD/DELETE. */
export const EMPTY_PAYLOAD_HASH = sha256Hex("");

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding as SigV4 wants it: everything but unreserved characters, `/` kept on request. */
export function uriEncode(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? encoded.replace(/%2F/g, "/") : encoded;
}

/** `20130524T000000Z` */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export interface SigningInput {
  method: string;
  /** Path and query must already be in their final (encoded) form; the path is signed as is. */
  url: URL;
  /** Headers to sign besides `host` (which comes from `url`); names in any case. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. Also sent as `x-amz-content-sha256`. */
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  date?: Date;
}

/**
 * AWS Signature Version 4 for a single request, header-based. Returns the headers to send:
 * the input headers plus `x-amz-date`, `x-amz-content-sha256` and `authorization`. `host` is
 * signed but not returned — fetch sets it from the URL.
 */
export function signRequest(input: SigningInput): Record<string, string> {
  const service = input.service ?? "s3";
  const timestamp = amzDate(input.date ?? new Date());
  const day = timestamp.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers))
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  headers["x-amz-date"] = timestamp;
  headers["x-amz-content-sha256"] = input.payloadHash;
  const signed: Record<string, string> = { ...headers, host: input.url.host };
  const names = Object.keys(signed).toSorted();

  const query = [...input.url.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .toSorted(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    input.url.pathname || "/",
    query,
    names.map((n) => `${n}:${signed[n]}\n`).join(""),
    names.join(";"),
    input.payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256Hex(canonicalRequest)].join(
    "\n",
  );
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return headers;
}
