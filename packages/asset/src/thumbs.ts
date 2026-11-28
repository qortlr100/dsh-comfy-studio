/**
 * Thumbnails: a WebP preview of an image or video asset that fits in 512 by 512 pixels, made with ffmpeg the first time
 * somebody asks and kept beside the asset's file (`thumbs/<id>.webp`). A thumbnail is a cache: deleting it only means it
 * is made again.
 *
 * @module @cs/asset/thumbs
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssetId } from "@cs/project";
import { kindOfMime, type StoredAsset } from "./types.ts";

/** The longest side of a thumbnail in pixels. */
export const THUMB_SIDE = 512;
/** The WebP quality of a thumbnail. */
const THUMB_QUALITY = "80";

/** The part of the ffmpeg service the asset component uses. */
export interface FfmpegPort {
  /** @returns whether ffmpeg can run on this machine. */
  available(): Promise<boolean>;
  /**
   * Run ffmpeg with `{{in:0}}` and `{{out:<name>}}` placeholders in `argv`.
   * @returns the absolute paths of the output files, in the order of `outputs`.
   */
  run(request: {
    argv: string[];
    inputs: string[];
    outputs: string[];
    dir: string;
  }): Promise<{ outputs: string[] }>;
}

/** What the thumbnail maker asks of its host. */
export interface ThumbnailDeps {
  /** @returns the entry of an asset, or undefined when no project folder holds it. */
  entry(asset: AssetId): StoredAsset | undefined;
  /** @returns the path of an asset's bytes. */
  path(asset: AssetId): string;
  /** @returns where an asset's thumbnail lives. */
  thumbPath(asset: AssetId): string;
  /** @returns the ffmpeg service now, or undefined while none is mounted. */
  ffmpeg(): FfmpegPort | undefined;
  /** Tell somebody that a thumbnail could not be made. */
  warn(message: string): void;
}

/** Makes thumbnails once per asset. */
export class Thumbnails {
  /** The runs in flight, so that concurrent requests for one asset share one run. */
  private readonly running = new Map<AssetId, Promise<string | null>>();
  /** The assets whose thumbnail failed; they are not tried again until the service restarts. */
  private readonly failed = new Set<AssetId>();

  private readonly deps: ThumbnailDeps;

  constructor(deps: ThumbnailDeps) {
    this.deps = deps;
  }

  /**
   * @param asset - an asset ID.
   * @returns the path of the asset's thumbnail, made now when it does not exist; null when the asset is not an image or
   *   a video, is unknown, ffmpeg is unavailable, or ffmpeg failed (the failure is remembered).
   */
  thumbOf(asset: AssetId): Promise<string | null> {
    const entry = this.deps.entry(asset);
    if (entry === undefined) return Promise.resolve(null);
    const kind = kindOfMime(entry.mime);
    if (kind !== "image" && kind !== "video") return Promise.resolve(null);
    const target = this.deps.thumbPath(asset);
    if (existsSync(target)) return Promise.resolve(target);
    if (this.failed.has(asset)) return Promise.resolve(null);
    const known = this.running.get(asset);
    if (known !== undefined) return known;
    const run = this.make(asset, kind, target).finally(() => {
      this.running.delete(asset);
    });
    this.running.set(asset, run);
    return run;
  }

  /**
   * @param asset - the asset.
   * @param kind - `image` or `video`.
   * @param target - the thumbnail's path.
   * @returns the thumbnail's path, or null after a failure.
   */
  private async make(
    asset: AssetId,
    kind: "image" | "video",
    target: string,
  ): Promise<string | null> {
    const ffmpeg = this.deps.ffmpeg();
    try {
      // Without ffmpeg nothing failed: it may be mounted later, so this is not remembered.
      if (ffmpeg === undefined || !(await ffmpeg.available())) return null;
      const dir = dirname(target);
      mkdirSync(dir, { recursive: true });
      const partialName = `${asset}.partial.webp`;
      const attempts = kind === "video" ? [["-ss", "0.5"], []] : [[]];
      let failure: unknown = null;
      for (const seek of attempts) {
        try {
          const { outputs } = await ffmpeg.run({
            argv: argvOf(seek, `{{out:${partialName}}}`),
            inputs: [this.deps.path(asset)],
            outputs: [partialName],
            dir,
          });
          const made = outputs[0];
          if (made === undefined) throw new Error("ffmpeg wrote no thumbnail.");
          renameSync(made, target);
          return target;
        } catch (error) {
          failure = error;
          rmSync(join(dir, partialName), { force: true });
        }
      }
      throw failure;
    } catch (error) {
      this.failed.add(asset);
      this.deps.warn(
        `could not make the thumbnail of asset ${asset}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

/**
 * @param seek - ffmpeg input options placed before the input, such as a seek.
 * @param output - the output placeholder.
 * @returns the ffmpeg command line: one frame scaled to fit the thumbnail side, never enlarged, as WebP.
 */
function argvOf(seek: string[], output: string): string[] {
  const fit = `scale=w='min(${String(THUMB_SIDE)},iw)':h='min(${String(THUMB_SIDE)},ih)':force_original_aspect_ratio=decrease`;
  return [
    "ffmpeg",
    "-y",
    "-loglevel",
    "error",
    ...seek,
    "-i",
    "{{in:0}}",
    "-frames:v",
    "1",
    "-vf",
    fit,
    "-c:v",
    "libwebp",
    "-quality",
    THUMB_QUALITY,
    output,
  ];
}
