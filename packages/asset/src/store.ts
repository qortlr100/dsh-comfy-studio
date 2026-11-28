/**
 * The asset file store: every file of a project, addressed by the SHA-256 of its bytes and never changed after it is
 * written. Each project keeps its files in its own folder, so a copy of the project folder holds the whole project:
 *
 * ```
 * <project folder>/.comfy-studio/assets/objects/<sha256>       the bytes, written once
 * <project folder>/.comfy-studio/assets/index.jsonl            one entry per asset, appended; the last line of an ID wins
 * <project folder>/.comfy-studio/assets/thumbs/<sha256>.webp   previews, made on demand (see `thumbs.ts`)
 * ```
 *
 * Two identical files in one project become one asset; the same bytes in two projects are two files with one ID. The
 * store follows DreamVerse `@dv/asset-pool` (MIT, commit ec0ac62760); it has no Cordis in it so tests can drive it.
 *
 * @module @cs/asset/store
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import {
  ProjectError,
  type AssetFacts,
  type AssetId,
  type ProjectId,
  type RecordId,
} from "@cs/project";
import { PROJECT_DIR } from "@cs/project/folder";
import { z } from "zod";
import { ASSET_ROUTES, kindOfMime, type StoredAsset } from "./types.ts";

/** The directory of a project folder that holds the asset files. */
const ASSETS_DIR = "assets";
const OBJECTS_DIR = "objects";
const THUMBS_DIR = "thumbs";
const INDEX_FILE = "index.jsonl";
/** Bytes read per step when a file is copied in, so that a large file never sits in memory. */
const CHUNK_BYTES = 1024 * 1024;

/** One line of `index.jsonl`. */
const entrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string(),
  name: z.string(),
  size_bytes: z.number(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration_sec: z.number().nullable(),
  has_audio: z.boolean().optional(),
});

/** What the store asks of its host. */
export interface AssetFilesDeps {
  /** @returns the folder of a project; throws `ProjectError` `unknown_project`. */
  folderOf(project: ProjectId): string;
  /** @returns the folder of every project. */
  folders(): string[];
  /** The base of the URLs the store makes, such as a tunnel origin; empty keeps them relative. */
  publicBaseUrl: string;
}

/** What `importAsset` takes besides the bytes. */
export interface ImportMeta {
  mime: string;
  name: string;
  durationSec?: number;
  width?: number;
  height?: number;
}

/** The media facts `describe` adds to an entry. */
export interface MediaFacts {
  width: number | null;
  height: number | null;
  durationSec: number | null;
  hasAudio?: boolean;
}

/** The content-addressed files of every project folder. */
export class AssetFiles {
  /** The `assets/` directory of each project folder read so far → the entries its index holds. */
  private readonly dirs = new Map<string, Map<AssetId, StoredAsset>>();

  private readonly deps: AssetFilesDeps;

  constructor(deps: AssetFilesDeps) {
    this.deps = deps;
  }

  /**
   * Store bytes, or a file's bytes, once in a project's folder; importing identical content into the same project again
   * returns the existing ID, keeps the first entry's name and creator, and leaves nothing behind.
   * @param project - the project whose folder receives the bytes.
   * @param source - the bytes, or the path of a file to copy in (read in chunks).
   * @param meta - the media type, the display name, and the pixel size and duration when known.
   * @param createdBy - the record that created the asset; null outside any record.
   * @returns the asset ID.
   * @throws ProjectError `unknown_project` before anything is written.
   */
  importAsset(
    project: ProjectId,
    source: Uint8Array | { path: string },
    meta: ImportMeta,
    createdBy: RecordId | null,
  ): AssetId {
    const dir = this.assetsDir(project);
    const objects = join(dir, OBJECTS_DIR);
    mkdirSync(objects, { recursive: true });
    // The ID is the hash of the bytes, known only after the copy, so the copy goes to a temporary name first.
    const partial = join(objects, `.${randomUUID()}.partial`);
    let id: AssetId;
    let size: number;
    try {
      ({ id, size } =
        source instanceof Uint8Array ? copyBytes(source, partial) : copyFile(source.path, partial));
      if (this.entries(dir).has(id)) {
        rmSync(partial, { force: true });
        return id;
      }
      // A crash leaves only a `.partial` file, never a half-written object under its hash.
      renameSync(partial, join(objects, id));
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
    this.append(dir, {
      id,
      mime: meta.mime,
      name: meta.name,
      size_bytes: size,
      created_by: createdBy,
      created_at: new Date().toISOString(),
      width: meta.width ?? null,
      height: meta.height ?? null,
      duration_sec: meta.durationSec ?? null,
    });
    return id;
  }

  /**
   * @param asset - an asset ID.
   * @returns the entry of the folder that holds it, or undefined.
   */
  find(asset: AssetId): StoredAsset | undefined {
    return this.locate(asset)?.entry;
  }

  /**
   * @param asset - an asset ID.
   * @returns the entry.
   * @throws ProjectError `unknown_asset` for an asset no project folder holds.
   */
  get(asset: AssetId): StoredAsset {
    return this.require(asset).entry;
  }

  /**
   * @param asset - an asset ID.
   * @returns whether a project folder holds it.
   */
  has(asset: AssetId): boolean {
    return this.locate(asset) !== undefined;
  }

  /**
   * @param asset - an asset ID.
   * @returns the absolute path of the stored bytes.
   * @throws ProjectError `unknown_asset`.
   */
  path(asset: AssetId): string {
    return join(this.require(asset).dir, OBJECTS_DIR, asset);
  }

  /**
   * @param asset - an asset ID.
   * @returns the absolute path where the asset's thumbnail lives (the file may not exist yet).
   * @throws ProjectError `unknown_asset`.
   */
  thumbPath(asset: AssetId): string {
    return join(this.require(asset).dir, THUMBS_DIR, `${asset}.webp`);
  }

  /**
   * @param asset - an asset ID.
   * @returns the stored bytes.
   * @throws ProjectError `unknown_asset`.
   */
  read(asset: AssetId): Buffer {
    return readFileSync(this.path(asset));
  }

  /**
   * @param asset - an asset ID.
   * @returns the size of the stored file in bytes.
   * @throws ProjectError `unknown_asset`.
   */
  size(asset: AssetId): number {
    return statSync(this.path(asset)).size;
  }

  /**
   * @param asset - an asset ID.
   * @returns the URL of its bytes under the configured public base.
   */
  url(asset: AssetId): string {
    return `${this.base()}${ASSET_ROUTES.file}?id=${asset}`;
  }

  /**
   * @param asset - an asset ID.
   * @returns the URL of its thumbnail for an image or video asset, else null.
   * @throws ProjectError `unknown_asset`.
   */
  thumbUrl(asset: AssetId): string | null {
    const kind = kindOfMime(this.get(asset).mime);
    return kind === "image" || kind === "video"
      ? `${this.base()}${ASSET_ROUTES.thumb}?id=${asset}`
      : null;
  }

  /**
   * Fill the media facts an entry does not know yet: append the updated entry to the index of the folder that holds
   * it. Facts the entry already holds stay.
   * @param asset - an asset ID.
   * @param media - the facts, each null when unknown.
   * @throws ProjectError `unknown_asset`.
   */
  describe(asset: AssetId, media: MediaFacts): void {
    const { dir, entry } = this.require(asset);
    const next: StoredAsset = {
      ...entry,
      width: entry.width ?? media.width,
      height: entry.height ?? media.height,
      duration_sec: entry.duration_sec ?? media.durationSec,
      ...(entry.has_audio === undefined && media.hasAudio !== undefined
        ? { has_audio: media.hasAudio }
        : {}),
    };
    if (
      next.width === entry.width &&
      next.height === entry.height &&
      next.duration_sec === entry.duration_sec &&
      next.has_audio === entry.has_audio
    ) {
      return;
    }
    this.append(dir, next);
  }

  /**
   * @param asset - an asset ID.
   * @returns what the project layer's `AssetStore.get` answers.
   * @throws ProjectError `unknown_asset`.
   */
  facts(asset: AssetId): AssetFacts {
    const entry = this.get(asset);
    return {
      mime: entry.mime,
      name: entry.name,
      size_bytes: entry.size_bytes,
      created_at: entry.created_at,
      width: entry.width,
      height: entry.height,
      duration_sec: entry.duration_sec,
      thumb_url: this.thumbUrl(asset),
    };
  }

  /** @returns the public base without trailing slashes. */
  private base(): string {
    return this.deps.publicBaseUrl.replace(/\/+$/, "");
  }

  /**
   * @param project - a project.
   * @returns the `assets/` directory of its folder.
   * @throws ProjectError `unknown_project`.
   */
  private assetsDir(project: ProjectId): string {
    return join(this.deps.folderOf(project), PROJECT_DIR, ASSETS_DIR);
  }

  /**
   * Append an entry to an index (the last line of an ID wins at replay) and keep it in memory.
   * @param dir - an `assets/` directory.
   * @param entry - the entry.
   */
  private append(dir: string, entry: StoredAsset): void {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, INDEX_FILE), `${JSON.stringify(entry)}\n`);
    this.entries(dir).set(entry.id, entry);
  }

  /**
   * The entries of one `assets/` directory, replayed from its index at first use. A malformed line and a line whose
   * object file is missing are skipped.
   * @param dir - the directory.
   * @returns asset ID → entry.
   */
  private entries(dir: string): Map<AssetId, StoredAsset> {
    const known = this.dirs.get(dir);
    if (known !== undefined) return known;
    const entries = new Map<AssetId, StoredAsset>();
    const indexPath = join(dir, INDEX_FILE);
    if (existsSync(indexPath)) {
      for (const line of readFileSync(indexPath, "utf8").split("\n")) {
        const entry = parseLine(line);
        if (entry !== null && existsSync(join(dir, OBJECTS_DIR, entry.id)))
          entries.set(entry.id, entry);
      }
    }
    this.dirs.set(dir, entries);
    return entries;
  }

  /**
   * Find the folder that stores an asset among the folders read so far; on a miss, read the folders of the projects
   * not read yet, such as one registered after start, and look once more.
   * @param id - an asset ID.
   * @returns the `assets/` directory and the entry, or undefined.
   */
  private locate(id: AssetId): { dir: string; entry: StoredAsset } | undefined {
    const find = (): { dir: string; entry: StoredAsset } | undefined => {
      for (const [dir, entries] of this.dirs) {
        const entry = entries.get(id);
        if (entry !== undefined) return { dir, entry };
      }
      return undefined;
    };
    const found = find();
    if (found !== undefined) return found;
    const unread = this.deps
      .folders()
      .map((folder) => join(folder, PROJECT_DIR, ASSETS_DIR))
      .filter((dir) => !this.dirs.has(dir));
    for (const dir of unread) this.entries(dir);
    return unread.length === 0 ? undefined : find();
  }

  /**
   * @param asset - an asset ID.
   * @returns the directory and entry.
   * @throws ProjectError `unknown_asset`.
   */
  private require(asset: AssetId): { dir: string; entry: StoredAsset } {
    const found = this.locate(asset);
    if (found === undefined)
      throw new ProjectError("unknown_asset", `Asset '${asset}' is not in the asset store.`);
    return found;
  }
}

/**
 * @param line - one line of an index.
 * @returns the entry, or null for an empty or malformed line.
 */
function parseLine(line: string): StoredAsset | null {
  if (line.trim() === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = entrySchema.safeParse(json);
  if (!parsed.success) return null;
  const { id, created_by, has_audio, ...rest } = parsed.data;
  return {
    ...rest,
    id: brandString<AssetId>(id),
    created_by: created_by === null ? null : brandString<RecordId>(created_by),
    ...(has_audio === undefined ? {} : { has_audio }),
  };
}

/**
 * Write bytes to a file and hash them.
 * @param bytes - the bytes.
 * @param target - the file to write.
 * @returns the asset ID and the size.
 */
function copyBytes(bytes: Uint8Array, target: string): { id: AssetId; size: number } {
  const fd = openSync(target, "w");
  try {
    writeAll(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return {
    id: brandString<AssetId>(createHash("sha256").update(bytes).digest("hex")),
    size: bytes.byteLength,
  };
}

/**
 * Copy a file in chunks while hashing it, so that its bytes never sit in memory as a whole.
 * @param from - the source file.
 * @param target - the file to write.
 * @returns the asset ID and the size.
 */
function copyFile(from: string, target: string): { id: AssetId; size: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let size = 0;
  const input = openSync(from, "r");
  try {
    const output = openSync(target, "w");
    try {
      for (;;) {
        const read = readSync(input, buffer, 0, CHUNK_BYTES, null);
        if (read === 0) break;
        const chunk = buffer.subarray(0, read);
        hash.update(chunk);
        writeAll(output, chunk);
        size += read;
      }
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
  return { id: brandString<AssetId>(hash.digest("hex")), size };
}

/**
 * @param fd - an open file.
 * @param bytes - what to write completely.
 */
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
}

/** The part of the ffmpeg service that reads media facts. */
export interface ProbePort {
  /** @returns the facts ffprobe reads from a file; a value is null when the file has none. */
  probe(path: string): Promise<{
    durationSec: number | null;
    videoDurationSec?: number | null;
    width: number | null;
    height: number | null;
    hasAudio?: boolean;
  }>;
}

/**
 * Read the pixel size and duration of an image, video or audio asset with ffprobe and add what its entry lacks. It is
 * best effort: a failure is reported to `warn` and nothing changes.
 * @param files - the store.
 * @param ffmpeg - the probing service.
 * @param asset - an asset the store holds.
 * @param warn - told about a failure.
 */
export async function probeMedia(
  files: AssetFiles,
  ffmpeg: ProbePort,
  asset: AssetId,
  warn: (message: string) => void,
): Promise<void> {
  const entry = files.get(asset);
  const kind = kindOfMime(entry.mime);
  if (kind === "file") return;
  try {
    const probed = await ffmpeg.probe(files.path(asset));
    if (kind === "audio") {
      // An audio file's video stream is its cover picture, so its size is not stored.
      files.describe(asset, { width: null, height: null, durationSec: probed.durationSec });
      return;
    }
    files.describe(asset, {
      width: probed.width,
      height: probed.height,
      durationSec: kind === "video" ? (probed.videoDurationSec ?? probed.durationSec) : null,
      ...(kind === "video" && probed.hasAudio !== undefined ? { hasAudio: probed.hasAudio } : {}),
    });
  } catch (error) {
    warn(
      `could not read the media facts of asset ${asset}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
