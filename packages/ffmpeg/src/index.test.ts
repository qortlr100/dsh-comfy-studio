/**
 * Unit tests of the `csFfmpeg` runner: placeholders, errors, probing, the managed subprocess path, the defaults,
 * `available()` and the concurrency limit. Cases that need a real ffmpeg skip when none is installed; the rest run on
 * fake binaries written as small node scripts.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { afterEach, describe, expect, it, vi } from "vitest";
import CsFfmpeg, { Config, FfmpegError } from "./index.ts";

const FFMPEG = process.env["CS_FFMPEG"] ?? "ffmpeg";
const FFPROBE = process.env["CS_FFPROBE"] ?? "ffprobe";
const hasFfmpeg =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;

/** The part of a subprocess handle that `csFfmpeg` reads. */
type FakeHandle = Pick<SubprocessHandle, "collected" | "done" | "terminate" | "waitForExit">;

interface Fixture {
  context: Context;
  ffmpeg: CsFfmpeg;
  dir: string;
}
const fixtures: Fixture[] = [];
const scratch: string[] = [];

/**
 * A stand-in for the harness subprocess service: spawns through `child_process` and exposes the collected streams the
 * way `SubprocessHandle` does, so the managed execution path runs without the real provider.
 */
class FakeSubprocess {
  readonly specs: SubprocessSpawnSpec[] = [];
  terminated = 0;
  /** Whether the handle exposes collected streams, as a provider configured without collection would not. */
  collectStreams = true;

  spawn(spec: SubprocessSpawnSpec): FakeHandle {
    this.specs.push(spec);
    const [program, ...args] = spec.argv;
    const child = spawn(program ?? "", args, { cwd: spec.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("close", (exitCode, signal) => {
          resolve({ exitCode, signal });
        });
        child.on("error", () => {
          resolve({ exitCode: null, signal: null });
        });
      },
    );
    return {
      collected: this.collectStreams
        ? {
            stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
          }
        : {},
      done,
      terminate: () => {
        this.terminated += 1;
        child.kill("SIGKILL");
      },
      waitForExit: () => done.then(() => true),
    };
  }
}

/**
 * Start the runner in a bare Cordis root.
 * @param config - config values to override; the binaries default to the real ones.
 * @param subprocess - a fake harness subprocess service, when the managed path is under test.
 * @returns the fixture with a scratch directory.
 */
async function start(config: Partial<Config> = {}, subprocess?: FakeSubprocess): Promise<Fixture> {
  const context = new Context();
  if (subprocess !== undefined) context.provide("subprocess", subprocess);
  await context.plugin(CsFfmpeg, { ffmpegPath: FFMPEG, ffprobePath: FFPROBE, ...config }).await();
  const fixture = {
    context,
    ffmpeg: context.csFfmpeg,
    dir: mkdtempSync(join(tmpdir(), "cs-ffmpeg-test-")),
  };
  fixtures.push(fixture);
  return fixture;
}

/**
 * Write an executable node script into a scratch directory.
 * @param name - the file name.
 * @param body - the script body after the shebang line.
 * @returns the script's path.
 */
function fakeBinary(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cs-ffmpeg-bin-"));
  scratch.push(dir);
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Render a solid-color clip into the fixture directory through `run` itself.
 * @param fixture - the fixture.
 * @param name - the output file name.
 * @param seconds - the clip length.
 * @returns the clip's path.
 */
async function clip(fixture: Fixture, name: string, seconds: number): Promise<string> {
  const result = await fixture.ffmpeg.run({
    argv: [
      "ffmpeg",
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=red:s=160x90:d=${seconds}:r=10`,
      "-pix_fmt",
      "yuv420p",
      `{{out:${name}}}`,
    ],
    inputs: [],
    outputs: [name],
    dir: fixture.dir,
  });
  return first(result.outputs);
}

/**
 * @param items - a list that must not be empty.
 * @returns its first item.
 */
function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    await fixture.context.fiber.dispose();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasFfmpeg)("csFfmpeg with ffmpeg", () => {
  it("runs a command with expanded inputs, outputs and list files, and probes the result", async () => {
    const fixture = await start();
    const red = await clip(fixture, "red.mp4", 1);
    expect(red).toBe(join(fixture.dir, "red.mp4"));
    const joined = await fixture.ffmpeg.run({
      argv: [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "list.txt",
        "-c",
        "copy",
        "{{out:joined.mp4}}",
      ],
      inputs: [red, red],
      outputs: ["joined.mp4"],
      dir: fixture.dir,
      files: [{ name: "list.txt", content: "file '{{in:0}}'\nfile '{{in:1}}'" }],
    });
    expect(readFileSync(join(fixture.dir, "list.txt"), "utf8")).toBe(
      `file '${red}'\nfile '${red}'`,
    );
    const probe = await fixture.ffmpeg.probe(first(joined.outputs));
    expect(probe).toMatchObject({ width: 160, height: 90, hasAudio: false, codec: "h264" });
    expect(probe.durationSec).toBeCloseTo(2, 0);
  });

  it("rejects placeholder mistakes, non-zero exits, and unwritten outputs with the command output", async () => {
    const fixture = await start();
    const red = await clip(fixture, "red.mp4", 1);
    const run = (argv: string[], inputs: string[], outputs: string[]) =>
      fixture.ffmpeg.run({ argv, inputs, outputs, dir: fixture.dir });
    await expect(run(["ffmpeg", "{{in:3}}"], [red], [])).rejects.toThrow("only 1 were given");
    await expect(run(["ffmpeg", "{{out:nope.mp4}}"], [], [])).rejects.toThrow(
      "undeclared output 'nope.mp4'",
    );
    await expect(
      run(["ffmpeg", "-i", "/no/such/file", "{{out:x.mp4}}"], [], ["x.mp4"]),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FfmpegError &&
        error.stderr.length > 0 &&
        error.message.includes("exited with"),
    );
    await expect(run(["ffmpeg", "-version"], [], ["never.mp4"])).rejects.toThrow(
      "did not write declared output 'never.mp4'",
    );
    await expect(run(["/no/such/program"], [], [])).rejects.toThrow(FfmpegError);
    await expect(run([], [], [])).rejects.toThrow();
    const text = join(fixture.dir, "note.txt");
    writeFileSync(text, "not a video");
    await expect(fixture.ffmpeg.probe(text)).rejects.toThrow(FfmpegError);
  });

  it("reads the last frame of video bytes as PNG bytes and removes its temporary directory", async () => {
    const fixture = await start();
    const halves = await fixture.ffmpeg.run({
      argv: [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=16x16:d=1:r=10",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=16x16:d=1:r=10",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1",
        "-pix_fmt",
        "yuv420p",
        "{{out:halves.mp4}}",
      ],
      inputs: [],
      outputs: ["halves.mp4"],
      dir: fixture.dir,
    });
    const run = vi.spyOn(fixture.ffmpeg, "run");
    const png = await fixture.ffmpeg.lastFrame(readFileSync(first(halves.outputs)));
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const temporary = first(run.mock.calls)[0].dir;
    expect(existsSync(temporary)).toBe(false);
    run.mockRestore();
    writeFileSync(join(fixture.dir, "last.png"), png);
    const pixel = await fixture.ffmpeg.run({
      argv: [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        "{{in:0}}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "{{out:pixel.rgb}}",
      ],
      inputs: [join(fixture.dir, "last.png")],
      outputs: ["pixel.rgb"],
      dir: fixture.dir,
    });
    const [red, , blue] = readFileSync(first(pixel.outputs));
    expect((blue ?? 0) > 200 && (red ?? 255) < 50).toBe(true);
    const failing = vi.spyOn(fixture.ffmpeg, "run");
    await expect(fixture.ffmpeg.lastFrame(Buffer.from("not a video"))).rejects.toThrow(FfmpegError);
    expect(existsSync(first(failing.mock.calls)[0].dir)).toBe(false);
  });

  it("runs through the harness subprocess service when it is mounted, and terminates on timeout", async () => {
    const subprocess = new FakeSubprocess();
    const fixture = await start({}, subprocess);
    const red = await clip(fixture, "red.mp4", 1);
    expect(subprocess.specs[0]?.argv[0]).toBe(FFMPEG);
    expect((await fixture.ffmpeg.probe(red)).codec).toBe("h264");
    await expect(
      fixture.ffmpeg.run({
        argv: ["sleep", "5"],
        inputs: [],
        outputs: [],
        dir: fixture.dir,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(FfmpegError);
    expect(subprocess.terminated).toBe(1);
    const silent = new FakeSubprocess();
    silent.collectStreams = false;
    const managed = await start({}, silent);
    expect(
      await managed.ffmpeg.run({
        argv: ["ffmpeg", "-version"],
        inputs: [],
        outputs: [],
        dir: managed.dir,
      }),
    ).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
  });
});

describe("csFfmpeg probe parsing and configuration", () => {
  it("reports nulls for fields ffprobe does not know, and the video stream duration", async () => {
    const fixture = await start();
    vi.spyOn(fixture.ffmpeg, "run").mockResolvedValueOnce({
      outputs: [],
      stdout: "{}",
      stderr: "",
      exitCode: 0,
    });
    expect(await fixture.ffmpeg.probe("/any")).toEqual({
      durationSec: null,
      videoDurationSec: null,
      width: null,
      height: null,
      hasAudio: false,
      codec: null,
    });
    vi.spyOn(fixture.ffmpeg, "run").mockResolvedValueOnce({
      outputs: [],
      stdout: JSON.stringify({
        streams: [
          { codec_type: "video", duration: "2.5", codec_name: "vp9" },
          { codec_type: "audio" },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });
    expect(await fixture.ffmpeg.probe("/any")).toEqual({
      durationSec: 2.5,
      videoDurationSec: 2.5,
      width: null,
      height: null,
      hasAudio: true,
      codec: "vp9",
    });
  });

  it("rejects probe output that is not JSON with an FfmpegError", async () => {
    const fixture = await start();
    vi.spyOn(fixture.ffmpeg, "run").mockResolvedValueOnce({
      outputs: [],
      stdout: "oops",
      stderr: "",
      exitCode: 0,
    });
    await expect(fixture.ffmpeg.probe("/any")).rejects.toThrow(FfmpegError);
  });

  it("defaults both binaries to bare names, the output limit and a concurrency of two", () => {
    expect(Config({})).toEqual({
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      outputLimitBytes: 1_048_576,
      concurrency: 2,
    });
    expect(Config({ ffmpegPath: "x", ffprobePath: "y" })).toMatchObject({
      ffmpegPath: "x",
      ffprobePath: "y",
    });
    expect(() => Config({ concurrency: 0 })).toThrow();
  });
});

describe("csFfmpeg with fake binaries", () => {
  it("reports availability from a binary that starts, and caches the answer", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "cs-ffmpeg-cnt-")), "count.txt");
    scratch.push(join(counter, ".."));
    const fake = fakeBinary(
      "ffmpeg",
      `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x");`,
    );
    const fixture = await start({ ffmpegPath: fake });
    expect(await fixture.ffmpeg.available()).toBe(true);
    expect(await fixture.ffmpeg.available()).toBe(true);
    expect(readFileSync(counter, "utf8")).toBe("x");
  });

  it("reports unavailable for a missing binary or one that exits non-zero", async () => {
    const missing = await start({ ffmpegPath: join(tmpdir(), "cs-ffmpeg-no-such-binary") });
    expect(await missing.ffmpeg.available()).toBe(false);
    const broken = await start({ ffmpegPath: fakeBinary("ffmpeg", "process.exit(3);") });
    expect(await broken.ffmpeg.available()).toBe(false);
  });

  it("runs a fake command and maps argv[0] to the configured binary", async () => {
    const fake = fakeBinary(
      "ffmpeg",
      `require("node:fs").writeFileSync(process.argv[2], process.argv.slice(3).join(","));`,
    );
    const fixture = await start({ ffmpegPath: fake });
    const result = await fixture.ffmpeg.run({
      argv: ["ffmpeg", "{{out:a.txt}}", "one", "two"],
      inputs: [],
      outputs: ["a.txt"],
      dir: fixture.dir,
    });
    expect(readFileSync(first(result.outputs), "utf8")).toBe("one,two");
  });

  it("runs at most `concurrency` processes at once", async () => {
    const fake = fakeBinary(
      "ffmpeg",
      `
const fs = require("node:fs");
const id = process.argv[2];
fs.appendFileSync("log.txt", "start " + id + "\\n");
setTimeout(() => { fs.appendFileSync("log.txt", "end " + id + "\\n"); }, 150);
`,
    );
    const fixture = await start({ ffmpegPath: fake, concurrency: 2 });
    const calls = ["a", "b", "c", "d", "e"].map((id) =>
      fixture.ffmpeg.run({ argv: ["ffmpeg", id], inputs: [], outputs: [], dir: fixture.dir }),
    );
    await Promise.all(calls);
    const lines = readFileSync(join(fixture.dir, "log.txt"), "utf8").trim().split("\n");
    let running = 0;
    let peak = 0;
    for (const line of lines) {
      running += line.startsWith("start") ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(2);
  });

  it("serves waiting calls in first-in-first-out order", async () => {
    const fake = fakeBinary(
      "ffmpeg",
      `
const fs = require("node:fs");
fs.appendFileSync("log.txt", process.argv[2] + "\\n");
`,
    );
    const fixture = await start({ ffmpegPath: fake, concurrency: 1 });
    const ids = ["a", "b", "c", "d", "e"];
    await Promise.all(
      ids.map((id) =>
        fixture.ffmpeg.run({ argv: ["ffmpeg", id], inputs: [], outputs: [], dir: fixture.dir }),
      ),
    );
    expect(readFileSync(join(fixture.dir, "log.txt"), "utf8").trim().split("\n")).toEqual(ids);
  });

  it("frees a slot when a command fails, so waiting calls still run", async () => {
    const fake = fakeBinary("ffmpeg", "process.exit(1);");
    const fixture = await start({ ffmpegPath: fake, concurrency: 1 });
    const run = () =>
      fixture.ffmpeg.run({ argv: ["ffmpeg"], inputs: [], outputs: [], dir: fixture.dir });
    const results = await Promise.allSettled([run(), run(), run()]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    const ok = await start({ ffmpegPath: fakeBinary("ffmpeg", "") });
    expect(await ok.ffmpeg.available()).toBe(true);
  });
});
