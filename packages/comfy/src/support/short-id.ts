import { randomBytes } from "node:crypto";

/**
 * A random id of `length` URL-safe characters (`A-Z`, `a-z`, `0-9`, `-`, `_`), for making an
 * uploaded file's name unique. Six characters hold 36 bits.
 */
export function shortId(length: number): string {
  // Three bytes make four base64url characters, so this always yields enough of them.
  return randomBytes(Math.ceil((length * 3) / 4))
    .toString("base64url")
    .slice(0, length);
}
