/**
 * Thumbnails with a fake ffmpeg: made once, concurrent requests share one run, failures are remembered, and
 * anything that is not an image or a video has none.
 */
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeFfmpeg, idOf, testStore } from "./testing/files.ts";
import { Thumbnails } from "./thumbs.ts";

/** A store with an image, a video and a text asset, and thumbnails over a fake ffmpeg. */
function setup() {
  const store = testStore();
  const project = store.addProject("p1");
  const ffmpeg = fakeFfmpeg();
  const warnings: string[] = [];
  let mounted = true;
  const thumbs = new Thumbnails({
    entry: (asset) => store.files.find(asset),
    path: (asset) => store.files.path(asset),
    thumbPath: (asset) => store.files.thumbPath(asset),
    ffmpeg: () => (mounted ? ffmpeg : undefined),
    warn: (message) => warnings.push(message),
  });
  const image = store.files.importAsset(
    project,
    new Uint8Array([1]),
    { mime: "image/png", name: "a.png" },
    null,
  );
  const video = store.files.importAsset(
    project,
    new Uint8Array([2]),
    { mime: "video/mp4", name: "v.mp4" },
    null,
  );
  const text = store.files.importAsset(
    project,
    new Uint8Array([3]),
    { mime: "text/plain", name: "t.txt" },
    null,
  );
  return {
    store,
    ffmpeg,
    warnings,
    thumbs,
    image,
    video,
    text,
    unmount: () => {
      mounted = false;
    },
  };
}

describe("Thumbnails", () => {
  it("makes a thumbnail once, in the asset's own folder", async () => {
    const { thumbs, ffmpeg, image, store } = setup();
    const path = await thumbs.thumbOf(image);
    expect(path).toBe(store.files.thumbPath(image));
    expect(existsSync(path ?? "")).toBe(true);
    expect(await thumbs.thumbOf(image)).toBe(path);
    expect(ffmpeg.runs).toHaveLength(1);
    const argv = ffmpeg.runs[0]?.argv.join(" ") ?? "";
    expect(argv).toContain(
      "scale=w='min(512,iw)':h='min(512,ih)':force_original_aspect_ratio=decrease",
    );
    expect(argv).toContain("-quality 80");
    expect(readdirSync(store.files.thumbPath(image).replace(/\/[^/]+$/, ""))).toEqual([
      `${image}.webp`,
    ]);
  });

  it("reads a video frame near the start", async () => {
    const { thumbs, ffmpeg, video } = setup();
    expect(await thumbs.thumbOf(video)).not.toBeNull();
    expect(ffmpeg.runs[0]?.argv).toContain("-ss");
  });

  it("shares one run between concurrent requests", async () => {
    const { thumbs, ffmpeg, image } = setup();
    const { promise, resolve: release } = Promise.withResolvers<void>();
    ffmpeg.gate = promise;
    const all = Promise.all([thumbs.thumbOf(image), thumbs.thumbOf(image), thumbs.thumbOf(image)]);
    release();
    const [a, b, c] = await all;
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(ffmpeg.runs).toHaveLength(1);
  });

  it("remembers a failure, warns once, and leaves no partial file", async () => {
    const { thumbs, ffmpeg, image, warnings, store } = setup();
    ffmpeg.failWith = "bad frame";
    expect(await thumbs.thumbOf(image)).toBeNull();
    expect(await thumbs.thumbOf(image)).toBeNull();
    expect(ffmpeg.runs).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad frame");
    expect(existsSync(store.files.thumbPath(image))).toBe(false);
  });

  it("tries a video again without the seek, then gives up", async () => {
    const { thumbs, ffmpeg, video } = setup();
    ffmpeg.failWith = "short";
    expect(await thumbs.thumbOf(video)).toBeNull();
    expect(ffmpeg.runs).toHaveLength(2);
    expect(ffmpeg.runs[1]?.argv).not.toContain("-ss");
  });

  it("answers null for other kinds and unknown assets", async () => {
    const { thumbs, ffmpeg, text } = setup();
    expect(await thumbs.thumbOf(text)).toBeNull();
    expect(await thumbs.thumbOf(idOf("unknown"))).toBeNull();
    expect(ffmpeg.runs).toHaveLength(0);
  });

  it("answers null without trying again later while ffmpeg is unavailable or missing", async () => {
    const { thumbs, ffmpeg, image, unmount, warnings } = setup();
    ffmpeg.availableNow = false;
    expect(await thumbs.thumbOf(image)).toBeNull();
    unmount();
    expect(await thumbs.thumbOf(image)).toBeNull();
    expect(warnings).toHaveLength(0);
    // Not a failure: when ffmpeg is back the thumbnail is made.
    ffmpeg.availableNow = true;
    const back = setup();
    expect(await back.thumbs.thumbOf(back.image)).not.toBeNull();
  });
});
