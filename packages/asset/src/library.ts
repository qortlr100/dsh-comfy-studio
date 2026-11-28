/**
 * The library listing: `asset.list` and the view API's asset list read the `asset` slice through `listAssets`. It is
 * pure: the store's entries, URLs and tool names come in through `deps`, so it needs no host module.
 *
 * @module @cs/asset/library
 */
import { ProjectError } from "@cs/project";
import type { AssetId, ProjectRecord, ProjectState, RecordId } from "@cs/project/types";
import { z as zod } from "zod";
import { emptySlice, normalizeTag } from "./reducer.ts";
import {
  ASSET_LIMITS,
  folderPath,
  kindOfMime,
  type AssetKind,
  type AssetListEntry,
  type AssetListReport,
  type AssetReview,
  type StoredAsset,
} from "./types.ts";

/** What `asset.list` filters by. */
export interface AssetListQuery {
  /** A folder ID, or `root` for the assets in no folder; subfolders are not included. Absent: every folder. */
  folder?: string;
  /** Default `adopted`. */
  review?: AssetReview;
  kind?: AssetKind;
  /** Words (at most 8): each must appear, in any case, in the name, a tag, or the producing record's intent or params. */
  q?: string;
  /** Tags (at most 5): the asset must carry all of them. */
  tags?: string[];
  /** 1 to 100; default 30. */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  cursor?: string;
}

/** What the listing needs from the host. */
export interface AssetListDeps {
  /** @returns the store's entry of an asset, or undefined when no project folder holds it. */
  entry(asset: AssetId): StoredAsset | undefined;
  /** @returns the URL that serves the asset. */
  url(asset: AssetId): string;
  /** @returns the agent tool name of an operation; null for an unknown operation or one without a tool. */
  toolOf(operation: string): string | null;
}

const cursorShape = zod.tuple([zod.string(), zod.string()]);

/**
 * @param added - an asset's `added_at`.
 * @param id - the asset's ID.
 * @returns the opaque cursor after that asset.
 */
function encodeCursor(added: string, id: string): string {
  return Buffer.from(JSON.stringify([added, id]), "utf8").toString("base64url");
}

/**
 * @param cursor - a cursor from a previous page.
 * @returns the `added_at` and ID it names.
 * @throws ProjectError `invalid_params` for a cursor that is not one of ours.
 */
export function decodeCursor(cursor: string): { added: string; id: string } {
  try {
    const [added, id] = cursorShape.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    return { added, id };
  } catch {
    throw new ProjectError(
      "invalid_params",
      "The cursor is not valid; pass the next_cursor of a previous page.",
    );
  }
}

/**
 * @param record - the record that made an asset, if it is in the history.
 * @returns the lower-cased texts a search looks in.
 */
function recordTexts(record: ProjectRecord | undefined): string[] {
  if (record === undefined) return [];
  return [record.intent, JSON.stringify(record.params)].map((text) => text.toLowerCase());
}

/**
 * List the assets of the library.
 * @param state - the project state.
 * @param deps - the store entries, URLs and tool names.
 * @param query - the filters and the page.
 * @returns one page, newest first, with the cursor of the next page.
 * @throws ProjectError `invalid_params` for a malformed cursor.
 */
export function listAssets(
  state: ProjectState,
  deps: AssetListDeps,
  query: AssetListQuery,
): AssetListReport {
  const slice = state.components.asset ?? emptySlice();
  const review = query.review ?? "adopted";
  const requested = query.limit;
  const limit =
    requested === undefined || !Number.isFinite(requested)
      ? ASSET_LIMITS.listDefault
      : Math.min(Math.max(Math.trunc(requested), 1), ASSET_LIMITS.listLimit);
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const words = (query.q ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, ASSET_LIMITS.searchWords);
  const tags = (query.tags ?? []).map(normalizeTag).slice(0, ASSET_LIMITS.filterTags);
  const records = new Map<RecordId, ProjectRecord>();
  for (const record of state.components.proj.records) records.set(record.id, record);

  const found: Array<{ item: (typeof slice.items)[AssetId]; entry: StoredAsset }> = [];
  for (const item of Object.values(slice.items)) {
    if (item.review !== review) continue;
    if (query.folder !== undefined) {
      if (query.folder === "root" ? item.folder !== null : item.folder !== query.folder) continue;
    }
    if (!tags.every((tag) => item.tags.includes(tag))) continue;
    const entry = deps.entry(item.id);
    if (entry === undefined) continue;
    if (query.kind !== undefined && kindOfMime(entry.mime) !== query.kind) continue;
    if (words.length > 0) {
      const texts = [
        entry.name.toLowerCase(),
        ...item.tags,
        ...recordTexts(records.get(item.record)),
      ];
      if (!words.every((word) => texts.some((text) => text.includes(word)))) continue;
    }
    found.push({ item, entry });
  }
  // Newest first; the ID breaks ties, so the order is total and a keyset cursor is exact.
  found.sort((a, b) =>
    a.item.added_at !== b.item.added_at
      ? a.item.added_at < b.item.added_at
        ? 1
        : -1
      : a.item.id < b.item.id
        ? 1
        : -1,
  );
  const rest =
    after === null
      ? found
      : found.filter(
          ({ item }) =>
            item.added_at < after.added || (item.added_at === after.added && item.id < after.id),
        );
  const page = rest.slice(0, limit);
  const last = page.at(-1);
  const entries = page.map(({ item, entry }): AssetListEntry => {
    const operation = item.origin === "output" ? records.get(item.record)?.operation : undefined;
    return {
      id: item.id,
      name: entry.name,
      kind: kindOfMime(entry.mime),
      mime: entry.mime,
      folder: item.folder === null ? null : folderPath(slice.folders, item.folder),
      review: item.review,
      tags: [...item.tags],
      origin: item.origin,
      record: item.record,
      made_by: operation === undefined || operation === null ? null : deps.toolOf(operation),
      added_at: item.added_at,
      url: deps.url(item.id),
    };
  });
  return {
    items: entries,
    next_cursor:
      rest.length > page.length && last !== undefined
        ? encodeCursor(last.item.added_at, last.item.id)
        : null,
  };
}
