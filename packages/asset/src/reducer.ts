/**
 * The reducer of the asset component: it turns the records of the history chain, and then the `asset.import` records
 * outside the history, into the `asset` state slice (the library with its folders, tags and review states).
 *
 * The reducer receives the chain first and the imports afterwards, so an import can arrive after steps that happened
 * later in real time. Rules 1 and 6 settle that with the records' `created_at` times and the slice's `marks`; the
 * rules are in `docs/archive/PLAN_2-3b.md` ("리듀서 규칙"). The reducer is pure and never throws: a record whose params do not
 * parse is skipped.
 *
 * @module @cs/asset/reducer
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import { z as zod } from "zod";
import type { AssetId, ProjectRecord, Reducer, RecordId } from "@cs/project/types";
import {
  ASSET_LIMITS,
  ASSET_OPERATIONS,
  SETTABLE_REVIEWS,
  folderPath,
  type AssetFolder,
  type AssetItem,
  type AssetMark,
  type AssetReview,
  type AssetSlice,
} from "./types.ts";

const recordId = zod.string().transform((value) => brandString<RecordId>(value));

const reviewParams = zod.object({ review: zod.enum(SETTABLE_REVIEWS) });
const moveParams = zod.object({ folder: recordId.nullish() });
const tagParams = zod.object({
  add: zod.array(zod.string()).optional(),
  remove: zod.array(zod.string()).optional(),
});
const folderCreateParams = zod.object({ name: zod.string(), parent: recordId.nullish() });
const folderUpdateParams = zod.object({
  folder: recordId,
  name: zod.string().optional(),
  // Absent leaves the parent; null moves the folder to the root.
  parent: recordId.nullable().optional(),
});
const folderDeleteParams = zod.object({ folder: recordId });

/** @returns the slice before any record. */
export function emptySlice(): AssetSlice {
  return { items: {}, folders: {}, marks: {} };
}

/**
 * @param tag - a tag as a caller wrote it.
 * @returns the tag trimmed and lower-cased; empty text for a tag that is only white space.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * @param name - a folder name as a caller wrote it.
 * @returns the name trimmed.
 */
export function normalizeFolderName(name: string): string {
  return name.trim();
}

/**
 * @param map - a record map.
 * @param key - a key.
 * @returns a copy of the map without the key.
 */
function withoutKey<K extends string, V>(map: Record<K, V>, key: K): Record<K, V> {
  const next = { ...map };
  Reflect.deleteProperty(next, key);
  return next;
}

/**
 * @param current - the tags now.
 * @param add - tags to attach.
 * @param remove - tags to detach; they go first, so a tag named in both ends up attached.
 * @returns the new tags: normalized, without repeats, sorted.
 */
export function applyTags(current: string[], add: string[], remove: string[]): string[] {
  const removed = new Set(remove.map(normalizeTag));
  const next = new Set(current.filter((tag) => !removed.has(tag)));
  for (const tag of add.map(normalizeTag)) if (tag !== "") next.add(tag);
  return [...next].toSorted();
}

/**
 * @param record - a record.
 * @returns the assets of its `asset` inputs, without repeats, in order.
 */
function inputAssets(record: ProjectRecord): AssetId[] {
  const found = new Set<AssetId>();
  for (const input of record.inputs) {
    if (input.role === "asset" && input.resolved_asset !== null) found.add(input.resolved_asset);
  }
  return [...found];
}

/** What a step says about assets: review, folder and tags. */
interface Change {
  review?: AssetReview;
  folder?: RecordId | null;
  add?: string[];
  remove?: string[];
}

/**
 * Apply a change to assets: to the item when the asset is in the library, else to its mark.
 * @param slice - the slice before.
 * @param assets - the assets.
 * @param change - what to change.
 * @param at - when the step was written.
 * @returns the slice after.
 */
function applyChange(slice: AssetSlice, assets: AssetId[], change: Change, at: string): AssetSlice {
  if (assets.length === 0) return slice;
  const items = { ...slice.items };
  const marks = { ...slice.marks };
  for (const id of assets) {
    const item = items[id];
    if (item !== undefined) {
      const next: AssetItem = { ...item };
      if (change.review !== undefined) {
        next.review = change.review;
        next.reviewed_at = at;
      }
      if (change.folder !== undefined) next.folder = change.folder;
      if (change.add !== undefined || change.remove !== undefined) {
        next.tags = applyTags(item.tags, change.add ?? [], change.remove ?? []);
      }
      items[id] = next;
      continue;
    }
    const next: AssetMark = { ...marks[id] };
    if (change.review !== undefined) {
      next.review = change.review;
      next.reviewed_at = at;
    }
    if (change.folder !== undefined) next.folder = change.folder;
    if (change.add !== undefined || change.remove !== undefined) {
      next.tags = applyTags(next.tags ?? [], change.add ?? [], change.remove ?? []);
    }
    marks[id] = next;
  }
  return { ...slice, items, marks };
}

/**
 * @param folders - the folders.
 * @param folder - a folder ID from a mark or a step.
 * @returns the ID when the folder exists, else null (the project root).
 */
function existingFolder(
  folders: AssetSlice["folders"],
  folder: RecordId | null | undefined,
): RecordId | null {
  return folder !== null && folder !== undefined && folders[folder] !== undefined ? folder : null;
}

/**
 * Rule 1: the outputs of a finished record of any component enter the library as pending.
 * @param slice - the slice before.
 * @param record - a done record other than `asset.import`.
 * @returns the slice after.
 */
function reduceOutputs(slice: AssetSlice, record: ProjectRecord): AssetSlice {
  if (record.outputs.length === 0) return slice;
  let items = slice.items;
  let marks = slice.marks;
  for (const id of record.outputs) {
    const mark = marks[id];
    // Already in the library. A mark beside an item is only ever the record of an earlier deletion (below), and it
    // stays: an import written before that deletion must not claim the asset when it is reduced.
    if (items[id] !== undefined) continue;
    // What steps said before an import that is still to come (review, folder, tags) belongs to the new item.
    const item: AssetItem = {
      id,
      origin: "output",
      record: record.id,
      added_at: record.created_at,
      review: mark?.review ?? "pending",
      folder: existingFolder(slice.folders, mark?.folder),
      tags: mark?.tags ?? [],
    };
    if (mark?.reviewed_at !== undefined) item.reviewed_at = mark.reviewed_at;
    items = { ...items, [id]: item };
    if (mark !== undefined) {
      // The deletion stays on record: an import written before it must not bring the asset back.
      marks =
        mark.deleted_at === undefined
          ? withoutKey(marks, id)
          : { ...marks, [id]: { deleted_at: mark.deleted_at } };
    }
  }
  return { ...slice, items, marks };
}

/**
 * Rule 4: a deleted asset leaves the library.
 * @param slice - the slice before.
 * @param record - a done `asset.delete` record.
 * @returns the slice after.
 */
function reduceDelete(slice: AssetSlice, record: ProjectRecord): AssetSlice {
  const assets = inputAssets(record);
  if (assets.length === 0) return slice;
  const items = { ...slice.items };
  const marks = { ...slice.marks };
  for (const id of assets) {
    Reflect.deleteProperty(items, id);
    marks[id] = { deleted_at: record.created_at };
  }
  return { ...slice, items, marks };
}

/**
 * @param folders - the folders.
 * @param parent - a parent folder, or null for the root.
 * @returns the position after the last folder of that parent.
 */
function nextPosition(folders: AssetSlice["folders"], parent: RecordId | null): number {
  let last = -1;
  for (const folder of Object.values(folders)) {
    if (folder.parent === parent && folder.position > last) last = folder.position;
  }
  return last + 1;
}

/**
 * @param folders - the folders.
 * @param root - a folder.
 * @returns the IDs of the folder and every folder below it.
 */
export function subtreeOf(folders: AssetSlice["folders"], root: RecordId): Set<RecordId> {
  const found = new Set<RecordId>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of Object.values(folders)) {
      if (folder.parent !== null && found.has(folder.parent) && !found.has(folder.id)) {
        found.add(folder.id);
        grew = true;
      }
    }
  }
  return found;
}

/**
 * Rule 5: `asset.folder_create`.
 * @param slice - the slice before.
 * @param record - a done record.
 * @returns the slice after.
 */
function reduceFolderCreate(slice: AssetSlice, record: ProjectRecord): AssetSlice {
  const parsed = folderCreateParams.safeParse(record.params);
  if (!parsed.success) return slice;
  const name = normalizeFolderName(parsed.data.name);
  if (name === "") return slice;
  const parent = existingFolder(slice.folders, parsed.data.parent);
  const folder: AssetFolder = {
    id: record.id,
    name,
    parent,
    position: nextPosition(slice.folders, parent),
  };
  return { ...slice, folders: { ...slice.folders, [record.id]: folder } };
}

/**
 * Rule 5: `asset.folder_update`.
 * @param slice - the slice before.
 * @param record - a done record.
 * @returns the slice after.
 */
function reduceFolderUpdate(slice: AssetSlice, record: ProjectRecord): AssetSlice {
  const parsed = folderUpdateParams.safeParse(record.params);
  if (!parsed.success) return slice;
  const folder = slice.folders[parsed.data.folder];
  if (folder === undefined) return slice;
  const next: AssetFolder = { ...folder };
  if (parsed.data.name !== undefined) {
    const name = normalizeFolderName(parsed.data.name);
    if (name !== "") next.name = name;
  }
  const parent = parsed.data.parent;
  if (parent !== undefined) {
    const target = existingFolder(slice.folders, parent);
    // A folder cannot go below itself.
    const cycle = target !== null && subtreeOf(slice.folders, folder.id).has(target);
    if (!cycle && (parent === null || target !== null)) {
      next.parent = target;
      next.position = nextPosition(slice.folders, target);
    }
  }
  return { ...slice, folders: { ...slice.folders, [folder.id]: next } };
}

/**
 * Rule 5: `asset.folder_delete`; the folder and everything below it go, and their assets move to the root.
 * @param slice - the slice before.
 * @param record - a done record.
 * @returns the slice after.
 */
function reduceFolderDelete(slice: AssetSlice, record: ProjectRecord): AssetSlice {
  const parsed = folderDeleteParams.safeParse(record.params);
  if (!parsed.success || slice.folders[parsed.data.folder] === undefined) return slice;
  const gone = subtreeOf(slice.folders, parsed.data.folder);
  const folders = { ...slice.folders };
  for (const id of gone) Reflect.deleteProperty(folders, id);
  const items = { ...slice.items };
  for (const item of Object.values(slice.items)) {
    if (item.folder !== null && gone.has(item.folder)) items[item.id] = { ...item, folder: null };
  }
  const marks = { ...slice.marks };
  for (const [id, mark] of Object.entries(slice.marks)) {
    if (mark.folder !== undefined && mark.folder !== null && gone.has(mark.folder)) {
      marks[brandString<AssetId>(id)] = { ...mark, folder: null };
    }
  }
  return { items, folders, marks };
}

/**
 * Rule 6: an import, written after every step of the chain. `at` is the import's time; a mark or an item decides
 * which side of it each thing happened.
 * @param slice - the slice before.
 * @param record - a done `asset.import` record.
 * @returns the slice after.
 */
function reduceImport(slice: AssetSlice, record: ProjectRecord): AssetSlice {
  const at = record.created_at;
  let items = slice.items;
  let marks = slice.marks;
  for (const id of new Set(record.outputs)) {
    const mark = marks[id];
    // A step deleted the asset after this import: the asset stays gone.
    if (mark?.deleted_at !== undefined && mark.deleted_at > at) continue;
    const item = items[id];
    if (item === undefined) {
      const added: AssetItem = {
        id,
        origin: "import",
        record: record.id,
        added_at: at,
        review: "adopted",
        folder: existingFolder(slice.folders, mark?.folder),
        tags: mark?.tags ?? [],
      };
      if (mark?.review !== undefined && mark.reviewed_at !== undefined && mark.reviewed_at > at) {
        added.review = mark.review;
        added.reviewed_at = mark.reviewed_at;
      }
      items = { ...items, [id]: added };
    } else {
      // An output of the same bytes that a later step made first in this order, yet happened after the import.
      const earlier = item.added_at > at;
      const next: AssetItem = earlier
        ? { ...item, origin: "import", record: record.id, added_at: at }
        : { ...item };
      if (next.reviewed_at === undefined || next.reviewed_at <= at) {
        next.review = "adopted";
        // An item that is the import's own with its default review has no time of a person's decision.
        if (!earlier || next.reviewed_at !== undefined) next.reviewed_at = at;
      }
      items = { ...items, [id]: next };
    }
    if (mark !== undefined) marks = withoutKey(marks, id);
  }
  return { ...slice, items, marks };
}

/**
 * Apply one record to the slice.
 * @param slice - the slice before.
 * @param record - the record.
 * @returns the slice after.
 */
function reduceRecord(slice: AssetSlice, record: ProjectRecord): AssetSlice {
  if (record.status !== "done") return slice;
  switch (record.operation) {
    case ASSET_OPERATIONS.import:
      return reduceImport(slice, record);
    case ASSET_OPERATIONS.review: {
      const parsed = reviewParams.safeParse(record.params);
      return parsed.success
        ? applyChange(slice, inputAssets(record), { review: parsed.data.review }, record.created_at)
        : slice;
    }
    case ASSET_OPERATIONS.move: {
      const parsed = moveParams.safeParse(record.params);
      if (!parsed.success) return slice;
      const folder = existingFolder(slice.folders, parsed.data.folder);
      return applyChange(slice, inputAssets(record), { folder }, record.created_at);
    }
    case ASSET_OPERATIONS.tag: {
      const parsed = tagParams.safeParse(record.params);
      if (!parsed.success) return slice;
      const change: Change = { add: parsed.data.add ?? [], remove: parsed.data.remove ?? [] };
      return applyChange(slice, inputAssets(record), change, record.created_at);
    }
    case ASSET_OPERATIONS.delete:
      return reduceDelete(slice, record);
    case ASSET_OPERATIONS.folderCreate:
      return reduceFolderCreate(slice, record);
    case ASSET_OPERATIONS.folderUpdate:
      return reduceFolderUpdate(slice, record);
    case ASSET_OPERATIONS.folderDelete:
      return reduceFolderDelete(slice, record);
    default:
      return reduceOutputs(slice, record);
  }
}

/** The reducer of the `asset` slice. */
export const assetReducer: Reducer<"asset"> = {
  initial: emptySlice,
  reduce: (slice, record) => reduceRecord(slice ?? emptySlice(), record),
  agentSummary(slice) {
    const current = slice ?? emptySlice();
    const counts = { adopted: 0, pending: 0, held: 0 };
    for (const item of Object.values(current.items)) counts[item.review] += 1;
    const total = counts.adopted + counts.pending + counts.held;
    const folders: Array<{ id: RecordId; path: string }> = [];
    for (const folder of Object.values(current.folders)) {
      const path = folderPath(current.folders, folder.id);
      if (path !== null) folders.push({ id: folder.id, path });
    }
    folders.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const shown = folders.slice(0, ASSET_LIMITS.summaryFolders);
    const more = folders.length - shown.length;
    return {
      ...(total > 0 ? { assets: counts } : {}),
      ...(shown.length > 0 ? { asset_folders: shown } : {}),
      ...(more > 0 ? { asset_folders_more: more } : {}),
    };
  },
  mentions: (slice) => Object.values(slice?.items ?? {}).map((item) => item.id),
};
