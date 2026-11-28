/**
 * Types of the asset feature component: one entry of the asset store, the `asset` state slice (the project's asset
 * library with its folders, tags and review state), and what the `asset.list` read answers.
 *
 * This file is the client face `@cs/asset/types`: it imports no host module, so a browser half can read it. The
 * reducer rules that compute the slice are in `reducer.ts`; the design is `docs/archive/PLAN_2-3b.md`.
 *
 * @module @cs/asset/types
 */
import type { AssetId, RecordId } from "@cs/project/types";

/** The component key, the prefix of every operation name, and the key of the state slice. */
export const ASSET_COMPONENT = "asset";

/** The operation names of the component. */
export const ASSET_OPERATIONS = {
  import: "asset.import",
  review: "asset.review",
  move: "asset.move",
  tag: "asset.tag",
  delete: "asset.delete",
  folderCreate: "asset.folder_create",
  folderUpdate: "asset.folder_update",
  folderDelete: "asset.folder_delete",
  list: "asset.list",
} as const;

/** The routes the component registers on dsh's connection (owner only). */
export const ASSET_ROUTES = {
  /** `GET|HEAD ?id=<asset>[&download=1]`: the bytes; one `Range: bytes=a-b` is honoured. */
  file: "/api/cs/asset",
  /** `GET|HEAD ?id=<asset>`: a WebP preview that fits in 512 pixels; 404 when none can be made. */
  thumb: "/api/cs/asset/thumb",
  /** `POST ?project=&name=&mime=[&folder=][&session=][&surface=]` with the bytes as the body. */
  upload: "/api/cs/asset/upload",
} as const;

/**
 * One asset the store holds, as one line of `<project folder>/.comfy-studio/assets/index.jsonl` stores it. The
 * width, height and duration are known when ffprobe could read them at import or the importer gave them.
 */
export interface StoredAsset {
  /** The SHA-256 hex digest of the bytes, which is also the file name under `objects/`. */
  readonly id: AssetId;
  /** The media type, such as `image/png` or `video/mp4`. */
  readonly mime: string;
  /** The display name, such as the uploaded file's name. */
  readonly name: string;
  readonly size_bytes: number;
  /** The record that created the asset; null for bytes that entered the store outside any record (an upload). */
  readonly created_by: RecordId | null;
  /** ISO-8601 UTC time of the first import. */
  readonly created_at: string;
  /** Pixel width, or null when unknown. */
  readonly width: number | null;
  /** Pixel height, or null when unknown. */
  readonly height: number | null;
  /** Duration of audio or video in seconds, or null when unknown. */
  readonly duration_sec: number | null;
  /** Whether a video holds a sound stream; absent until it was first probed. */
  readonly has_audio?: boolean;
}

/** Whether a person keeps an asset: waiting for the decision, kept, or set aside. */
export type AssetReview = "pending" | "adopted" | "held";

/** The review states a person can set; `pending` is only the default of an operation's output. */
export const SETTABLE_REVIEWS = ["adopted", "held"] as const;

/** The broad kind of an asset, from its media type. */
export type AssetKind = "image" | "video" | "audio" | "file";

/**
 * @param mime - a media type.
 * @returns `image`, `video` or `audio` by the top-level type, else `file`.
 */
export function kindOfMime(mime: string): AssetKind {
  const top = mime.split("/")[0];
  return top === "image" || top === "video" || top === "audio" ? top : "file";
}

/** One asset of the project's library. */
export interface AssetItem {
  id: AssetId;
  /** `import`: a person brought the file in. `output`: an operation made it. */
  origin: "import" | "output";
  /** The record that first brought the asset into the library. */
  record: RecordId;
  /** When that record was written, ISO-8601 UTC. */
  added_at: string;
  review: AssetReview;
  /** When `review` was last set by a person or an import; absent while it is the default of an output. */
  reviewed_at?: string;
  /** The folder; null for the project root. */
  folder: RecordId | null;
  /** Lower-case tags, sorted. */
  tags: string[];
}

/** One folder of the library. Its ID is the record that created it. */
export interface AssetFolder {
  id: RecordId;
  name: string;
  /** The parent folder; null for a folder of the project root. */
  parent: RecordId | null;
  /** The order among siblings, 0 first. */
  position: number;
}

/**
 * What steps said about an asset that is not in the library: it was deleted, or its import (a record outside the
 * history, which the reducer receives after every step) has not been reduced yet. Views ignore marks.
 */
export interface AssetMark {
  review?: AssetReview;
  reviewed_at?: string;
  folder?: RecordId | null;
  tags?: string[];
  /** When a step deleted the asset, ISO-8601 UTC. */
  deleted_at?: string;
}

/** The `asset` state slice. */
export interface AssetSlice {
  /** The assets in the library now, by ID. A deleted asset is not here. */
  items: Record<AssetId, AssetItem>;
  /** The folders, by ID. */
  folders: Record<RecordId, AssetFolder>;
  /** Marks of assets that are not in `items`. */
  marks: Record<AssetId, AssetMark>;
}

/** The limits the operations enforce before a record is written. */
export const ASSET_LIMITS = {
  /** A folder at the project root has depth 1. */
  folderDepth: 4,
  folderNameChars: 100,
  tagChars: 40,
  /** Tags one `asset.tag` call adds, and removes. */
  tagsPerCall: 20,
  tagsPerAsset: 50,
  listLimit: 100,
  listDefault: 30,
  /** Words of one `asset.list` search. */
  searchWords: 8,
  /** Tags one `asset.list` call filters by. */
  filterTags: 5,
  /** Folders the agent summary lists. */
  summaryFolders: 40,
} as const;

/** One asset as `asset.list` answers it. */
export interface AssetListEntry {
  id: AssetId;
  name: string;
  kind: AssetKind;
  mime: string;
  /** The folder's path, such as `characters/hero`; null for the project root. */
  folder: string | null;
  review: AssetReview;
  tags: string[];
  origin: AssetItem["origin"];
  record: RecordId;
  /** The agent tool of the operation that made the asset; null for an import or an unknown operation. */
  made_by: string | null;
  added_at: string;
  url: string;
}

/** What `asset.list` answers in its report. */
export interface AssetListReport {
  items: AssetListEntry[];
  /** Pass it back as `cursor` for older assets; null at the end. */
  next_cursor: string | null;
}

/**
 * @param folders - the folders of a slice.
 * @param id - a folder ID.
 * @returns the folder's path from the root, names joined by `/`; null for an unknown folder or a parent cycle.
 */
export function folderPath(folders: AssetSlice["folders"], id: RecordId): string | null {
  const names: string[] = [];
  const seen = new Set<RecordId>();
  let current: RecordId | null = id;
  while (current !== null) {
    const folder: AssetFolder | undefined = folders[current];
    if (folder === undefined || seen.has(current)) return null;
    seen.add(current);
    names.unshift(folder.name);
    current = folder.parent;
  }
  return names.join("/");
}

declare module "@cs/project/types" {
  interface ComponentStates {
    /** The asset library; absent while the asset component is not loaded. */
    asset?: AssetSlice;
  }
}
