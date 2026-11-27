/**
 * Text chunks of a PNG file (`tEXt`, `iTXt`), for reading the generation info that ComfyUI and
 * other tools embed in their outputs. Pure logic with no Node-only APIs, shared by the browser
 * (the workflow upload area reads a dropped PNG) and the server.
 *
 * Compressed text (`zTXt`, compressed `iTXt`) needs zlib, which the browser path does not have:
 * it is skipped unless the caller passes `inflate` (see `png-text.server.ts`).
 *
 * Limits: only the first `PNG_TEXT_SCAN_LIMIT` bytes of the file are walked. Chunks that start
 * after it, or a text chunk that runs past it, are not read, and the entries found before it are
 * returned (encoders write text chunks before or right after the image data, so a ComfyUI output
 * larger than the limit still yields its `prompt`). At most `PNG_TEXT_MAX_ENTRIES` entries are
 * collected. A missing PNG signature or a chunk cut short throws `PngTextError`. CRCs are not
 * checked. Pass the whole file: a head slice reads as a cut-short chunk.
 */

export const PNG_TEXT_SCAN_LIMIT = 2 * 1024 * 1024;
export const PNG_TEXT_MAX_ENTRIES = 64;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PngTextError extends Error {}

export interface PngTextOptions {
  /**
   * zlib inflate for `zTXt` and compressed `iTXt`; without it those chunks are skipped. It may
   * throw (bad data, output over its own cap); the chunk is then skipped.
   */
  inflate?: (data: Uint8Array) => Uint8Array;
}

const utf8 = new TextDecoder("utf-8");

/** Latin-1 decode (tEXt/zTXt); TextDecoder("latin1") is windows-1252, which differs in 0x80-0x9f. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

/** The bytes from `from` up to the next NUL and the index after that NUL, or null without one. */
function untilNul(data: Uint8Array, from: number): [Uint8Array, number] | null {
  const end = data.indexOf(0, from);
  return end < 0 ? null : [data.subarray(from, end), end + 1];
}

/** One text chunk as `[keyword, text]`, or null when it is malformed or cannot be decoded here. */
function readText(
  type: string,
  data: Uint8Array,
  inflate: PngTextOptions["inflate"],
): [string, string] | null {
  const head = untilNul(data, 0);
  if (!head || head[0].length === 0) return null;
  const keyword = latin1(head[0]);
  const rest = head[1];
  try {
    if (type === "tEXt") return [keyword, latin1(data.subarray(rest))];
    if (type === "zTXt") {
      // keyword\0 method(1, 0 = deflate) compressed-text
      if (!inflate || data[rest] !== 0) return null;
      return [keyword, latin1(inflate(data.subarray(rest + 1)))];
    }
    // iTXt: keyword\0 flag(1) method(1) language\0 translated-keyword\0 text (UTF-8)
    const flag = data[rest];
    const language = untilNul(data, rest + 2);
    const translated = language && untilNul(data, language[1]);
    if (!translated) return null;
    const text = data.subarray(translated[1]);
    if (flag === 0) return [keyword, utf8.decode(text)];
    if (flag !== 1 || !inflate || data[rest + 1] !== 0) return null;
    return [keyword, utf8.decode(inflate(text))];
  } catch {
    return null;
  }
}

/**
 * The PNG's text entries as `[keyword, text]` in file order (keywords may repeat). Throws
 * `PngTextError` when `bytes` is not a PNG or a chunk is cut short.
 */
export function pngTextChunks(
  bytes: Uint8Array,
  opts: PngTextOptions = {},
): [keyword: string, text: string][] {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b))
    throw new PngTextError("PNG 파일이 아닙니다");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: [string, string][] = [];
  let offset = SIGNATURE.length;
  while (offset < PNG_TEXT_SCAN_LIMIT && out.length < PNG_TEXT_MAX_ENTRIES) {
    if (offset + 8 > bytes.length)
      throw new PngTextError("PNG 파일이 중간에 잘렸습니다 (IEND 청크가 없음)");
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length)
      throw new PngTextError(`PNG 파일이 중간에 잘렸습니다 (${type} 청크, 오프셋 ${offset})`);
    if (type === "IEND") break;
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      if (dataEnd > PNG_TEXT_SCAN_LIMIT) break;
      const entry = readText(type, bytes.subarray(dataStart, dataEnd), opts.inflate);
      if (entry) out.push(entry);
    }
    offset = dataEnd + 4; // skip the CRC
  }
  return out;
}
