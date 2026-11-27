import { inflateSync } from "node:zlib";
import { PNG_TEXT_SCAN_LIMIT, pngTextChunks } from "./png-text.ts";

/**
 * `pngTextChunks` that also reads compressed text (`zTXt`, compressed `iTXt`) with `node:zlib`.
 * Each chunk inflates to at most `PNG_TEXT_SCAN_LIMIT` bytes; a larger one is skipped.
 */
export function pngTextChunksWithCompressed(bytes: Uint8Array): [keyword: string, text: string][] {
  return pngTextChunks(bytes, {
    inflate: (data) => inflateSync(data, { maxOutputLength: PNG_TEXT_SCAN_LIMIT }),
  });
}
