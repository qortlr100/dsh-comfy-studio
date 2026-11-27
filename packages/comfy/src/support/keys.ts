import path from "node:path";

/** Normalizes a storage key and refuses ones that would escape the storage root. */
export function safeKey(key: string): string {
  const normalized = path.posix.normalize(key).replace(/^(\.\.(\/|$))+/, "");
  if (normalized.startsWith("/") || normalized.includes(".."))
    throw new Error("Invalid storage key");
  return normalized;
}
