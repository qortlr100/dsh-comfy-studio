/**
 * Test helpers of the asset package: a store over temporary project folders that needs no Cordis, and a fake ffmpeg.
 *
 * @module @cs/asset/testing/files
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { onTestFinished } from "vitest";
import { ProjectError, type AssetId, type ProjectId } from "@cs/project";
import { AssetFiles } from "../store.ts";
import type { FfmpegPort } from "../thumbs.ts";

/**
 * @returns a fresh temporary directory, removed when the test ends.
 */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cs-asset-test-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * @param bytes - some bytes.
 * @returns the asset ID of those bytes.
 */
export function idOf(bytes: Uint8Array | string): AssetId {
  return brandString<AssetId>(createHash("sha256").update(bytes).digest("hex"));
}

/** A store over temporary project folders, with the project registry the host would give. */
export interface TestStore {
  root: string;
  files: AssetFiles;
  /** Register a project and make its folder. */
  addProject: (name: string) => ProjectId;
  /** A second store over the same folders, as after a restart. */
  restart: () => AssetFiles;
}

/**
 * @param publicBaseUrl - the store's public base.
 * @returns a store in a temporary directory.
 */
export function testStore(publicBaseUrl = ""): TestStore {
  const root = tempDir();
  const folders = new Map<ProjectId, string>();
  const make = (): AssetFiles =>
    new AssetFiles({
      folderOf: (project) => {
        const folder = folders.get(project);
        if (folder === undefined)
          throw new ProjectError("unknown_project", `Unknown project '${project}'.`);
        return folder;
      },
      folders: () => [...folders.values()],
      publicBaseUrl,
    });
  return {
    root,
    files: make(),
    addProject(name) {
      const id = brandString<ProjectId>(name);
      const folder = join(root, name);
      mkdirSync(folder, { recursive: true });
      folders.set(id, folder);
      return id;
    },
    restart: make,
  };
}

/**
 * @param dir - a directory.
 * @param name - a file name.
 * @param content - the file's bytes.
 * @returns the path of the new file.
 */
export function writeFile(dir: string, name: string, content: Uint8Array | string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** A fake ffmpeg that records its calls and writes a file for each output. */
export interface FakeFfmpeg extends FfmpegPort {
  availableNow: boolean;
  /** Fail each run with this message; null to succeed. */
  failWith: string | null;
  runs: Array<{ argv: string[]; inputs: string[]; outputs: string[]; dir: string }>;
  /** When set, a run waits for it before it finishes. */
  gate: Promise<void> | null;
}

/** @returns a fake ffmpeg. */
export function fakeFfmpeg(): FakeFfmpeg {
  const fake: FakeFfmpeg = {
    availableNow: true,
    failWith: null,
    runs: [],
    gate: null,
    available: () => Promise.resolve(fake.availableNow),
    async run(request) {
      fake.runs.push(request);
      if (fake.gate !== null) await fake.gate;
      if (fake.failWith !== null) throw new Error(fake.failWith);
      const outputs = request.outputs.map((name) => {
        const path = join(request.dir, name);
        writeFileSync(path, "RIFFfakewebp");
        return path;
      });
      return { outputs };
    },
  };
  return fake;
}
