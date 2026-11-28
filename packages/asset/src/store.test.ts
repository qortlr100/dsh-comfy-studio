/**
 * The asset file store against real temporary folders: import from bytes and from a path, identical bytes once, the
 * index across a restart, the same bytes in two projects, unknown projects, damaged index lines, and media facts.
 */
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brandString } from "@deepseek-ai/dsh-brand";
import { ProjectError, type ProjectId } from "@cs/project";
import { PROJECT_DIR } from "@cs/project/folder";
import { idOf, tempDir, testStore, writeFile } from "./testing/files.ts";
import { probeMedia } from "./store.ts";

const PNG = { mime: "image/png", name: "a.png" };

describe("AssetFiles.importAsset", () => {
  it("stores bytes under their SHA-256 and describes them", () => {
    const { files, addProject, root } = testStore();
    const project = addProject("p1");
    const bytes = new TextEncoder().encode("hello");
    const id = files.importAsset(project, bytes, { ...PNG, width: 3, height: 4 }, null);
    expect(id).toBe(idOf(bytes));
    expect(files.path(id)).toBe(join(root, "p1", PROJECT_DIR, "assets", "objects", id));
    expect(files.read(id).toString()).toBe("hello");
    expect(files.size(id)).toBe(5);
    expect(files.get(id)).toMatchObject({
      mime: "image/png",
      name: "a.png",
      size_bytes: 5,
      width: 3,
      height: 4,
    });
    expect(files.has(id)).toBe(true);
  });

  it("copies a file by path and gives the same ID as the bytes", () => {
    const { files, addProject, root } = testStore();
    const project = addProject("p1");
    const path = writeFile(root, "src.bin", "from a file");
    const id = files.importAsset(
      project,
      { path },
      { mime: "application/octet-stream", name: "src.bin" },
      null,
    );
    expect(id).toBe(idOf("from a file"));
    expect(files.read(id).toString()).toBe("from a file");
  });

  it("copies a file larger than one chunk and leaves no partial file", () => {
    const { files, addProject, root } = testStore();
    const project = addProject("p1");
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    const path = writeFile(root, "big.bin", big);
    const id = files.importAsset(project, { path }, { mime: "video/mp4", name: "big.mp4" }, null);
    expect(id).toBe(idOf(big));
    expect(files.size(id)).toBe(big.length);
    expect(readdirSync(join(root, "p1", PROJECT_DIR, "assets", "objects"))).toEqual([id]);
  });

  it("stores identical bytes once and keeps the first entry", () => {
    const { files, addProject, root } = testStore();
    const project = addProject("p1");
    const first = files.importAsset(project, new Uint8Array([1, 2, 3]), PNG, null);
    const second = files.importAsset(
      project,
      new Uint8Array([1, 2, 3]),
      { mime: "image/png", name: "b.png" },
      null,
    );
    expect(second).toBe(first);
    expect(files.get(first).name).toBe("a.png");
    const assets = join(root, "p1", PROJECT_DIR, "assets");
    expect(readdirSync(join(assets, "objects"))).toEqual([first]);
    expect(readFileSync(join(assets, "index.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("keeps the same bytes of two projects as two files with one ID", () => {
    const { files, addProject, root } = testStore();
    const one = addProject("p1");
    const two = addProject("p2");
    const a = files.importAsset(one, new Uint8Array([9]), PNG, null);
    const b = files.importAsset(two, new Uint8Array([9]), PNG, null);
    expect(a).toBe(b);
    expect(existsSync(join(root, "p1", PROJECT_DIR, "assets", "objects", a))).toBe(true);
    expect(existsSync(join(root, "p2", PROJECT_DIR, "assets", "objects", b))).toBe(true);
  });

  it("refuses an unknown project before writing anything", () => {
    const { files, root } = testStore();
    const unknown = brandString<ProjectId>("nope");
    expect(() => files.importAsset(unknown, new Uint8Array([1]), PNG, null)).toThrow(ProjectError);
    expect(readdirSync(root)).toEqual([]);
  });

  it("does not leave a partial file when the source is missing", () => {
    const { files, addProject, root } = testStore();
    const project = addProject("p1");
    expect(() => files.importAsset(project, { path: join(root, "nope") }, PNG, null)).toThrow();
    expect(readdirSync(join(root, "p1", PROJECT_DIR, "assets", "objects"))).toEqual([]);
  });
});

describe("AssetFiles reading back", () => {
  it("finds assets after a restart and finds a project registered later", () => {
    const store = testStore();
    const project = store.addProject("p1");
    const id = store.files.importAsset(project, new Uint8Array([4, 5]), PNG, null);
    const again = store.restart();
    expect(again.find(id)?.name).toBe("a.png");
    expect(again.read(id)).toEqual(Buffer.from([4, 5]));
    // A project whose folder appeared after the store started is read on a miss.
    const late = store.addProject("p2");
    const other = store.files.importAsset(late, new Uint8Array([6]), PNG, null);
    expect(again.has(other)).toBe(true);
  });

  it("throws unknown_asset for an unknown asset", () => {
    const { files } = testStore();
    expect(files.find(idOf("none"))).toBeUndefined();
    expect(() => files.get(idOf("none"))).toThrowError(
      expect.objectContaining({ code: "unknown_asset" }),
    );
    expect(() => files.path(idOf("none"))).toThrow(ProjectError);
  });

  it("skips malformed lines and lines whose object is missing", () => {
    const store = testStore();
    const project = store.addProject("p1");
    const good = store.files.importAsset(project, new Uint8Array([1]), PNG, null);
    const gone = store.files.importAsset(project, new Uint8Array([2]), PNG, null);
    const assets = join(store.root, "p1", PROJECT_DIR, "assets");
    rmSync(join(assets, "objects", gone));
    appendFileSync(join(assets, "index.jsonl"), 'not json\n{"id":"short"}\n\n{"id":1}\n');
    const again = store.restart();
    expect(again.has(good)).toBe(true);
    expect(again.has(gone)).toBe(false);
  });

  it("lets the last line of an ID win", () => {
    const store = testStore();
    const project = store.addProject("p1");
    const id = store.files.importAsset(project, new Uint8Array([1]), PNG, null);
    const index = join(store.root, "p1", PROJECT_DIR, "assets", "index.jsonl");
    const line = readFileSync(index, "utf8").trim();
    writeFileSync(index, `${line}\n${line.replace('"name":"a.png"', '"name":"renamed.png"')}\n`);
    expect(store.restart().get(id).name).toBe("renamed.png");
  });
});

describe("facts, URLs and describe", () => {
  it("builds the file and thumb URLs under the public base", () => {
    const { files, addProject } = testStore("https://x.example//");
    const project = addProject("p1");
    const image = files.importAsset(project, new Uint8Array([1]), PNG, null);
    const text = files.importAsset(
      project,
      new Uint8Array([2]),
      { mime: "text/plain", name: "t.txt" },
      null,
    );
    expect(files.url(image)).toBe(`https://x.example/api/cs/asset?id=${image}`);
    expect(files.thumbUrl(image)).toBe(`https://x.example/api/cs/asset/thumb?id=${image}`);
    expect(files.thumbUrl(text)).toBeNull();
    expect(files.facts(image)).toMatchObject({
      mime: "image/png",
      size_bytes: 1,
      thumb_url: files.thumbUrl(image),
    });
    expect(files.facts(text).thumb_url).toBeNull();
  });

  it("adds the facts an entry lacks, keeps those it has, and survives a restart", () => {
    const store = testStore();
    const project = store.addProject("p1");
    const id = store.files.importAsset(project, new Uint8Array([1]), { ...PNG, width: 10 }, null);
    store.files.describe(id, { width: 99, height: 20, durationSec: 3, hasAudio: true });
    const entry = store.restart().get(id);
    expect(entry).toMatchObject({ width: 10, height: 20, duration_sec: 3, has_audio: true });
  });

  it("writes nothing when describe changes nothing", () => {
    const store = testStore();
    const project = store.addProject("p1");
    const id = store.files.importAsset(
      project,
      new Uint8Array([1]),
      { ...PNG, width: 1, height: 1 },
      null,
    );
    store.files.describe(id, { width: 5, height: 5, durationSec: null });
    const index = join(store.root, "p1", PROJECT_DIR, "assets", "index.jsonl");
    expect(readFileSync(index, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("probeMedia", () => {
  it("adds the size of an image and the duration of a video, and warns on failure", async () => {
    const store = testStore();
    const project = store.addProject("p1");
    const image = store.files.importAsset(project, new Uint8Array([1]), PNG, null);
    const video = store.files.importAsset(
      project,
      new Uint8Array([2]),
      { mime: "video/mp4", name: "v.mp4" },
      null,
    );
    const text = store.files.importAsset(
      project,
      new Uint8Array([3]),
      { mime: "text/plain", name: "t" },
      null,
    );
    const warnings: string[] = [];
    const ffmpeg = {
      probe: () =>
        Promise.resolve({
          durationSec: 9,
          videoDurationSec: 8,
          width: 640,
          height: 480,
          hasAudio: true,
        }),
    };
    for (const asset of [image, video, text]) {
      await probeMedia(store.files, ffmpeg, asset, (message) => warnings.push(message));
    }
    expect(store.files.get(image)).toMatchObject({ width: 640, height: 480, duration_sec: null });
    expect(store.files.get(video)).toMatchObject({ width: 640, duration_sec: 8, has_audio: true });
    expect(store.files.get(text).width).toBeNull();
    await probeMedia(store.files, { probe: () => Promise.reject(new Error("boom")) }, image, (m) =>
      warnings.push(m),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("boom");
  });
});

describe("test helpers", () => {
  it("make separate temporary directories", () => {
    expect(tempDir()).not.toBe(tempDir());
  });
});
