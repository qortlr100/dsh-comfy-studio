// The shell's own "this browser has been here" marker, kept in `localStorage`. dsh's own saved
// state is never read: whether it is there says nothing the shell may lean on.

import { VISITED_KEY } from "./ids.ts";

/** The two calls of `Storage` the marker uses; a test hands a plain object. */
export interface MarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Tell whether this is the browser's first visit, and mark the browser as visited.
 * A browser that refuses storage (private mode, blocked site data) counts as a first visit
 * every time and keeps no marker, without throwing.
 * @param storage - where the marker lives; null when the browser has no usable storage.
 * @returns true when the marker was absent.
 */
export function claimFirstVisit(storage: MarkerStorage | null): boolean {
  if (storage === null) return true;
  let first = true;
  try {
    first = storage.getItem(VISITED_KEY) === null;
  } catch {
    // Unreadable storage: treated as a first visit.
  }
  try {
    storage.setItem(VISITED_KEY, "1");
  } catch {
    // Unwritable storage: the next page load is a first visit again.
  }
  return first;
}

/**
 * The page's `localStorage`, or null when the browser refuses even to hand it over.
 * @returns the storage, or null.
 */
export function pageStorage(): MarkerStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
