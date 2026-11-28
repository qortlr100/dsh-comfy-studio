/**
 * The ffmpeg runner as the `csFfmpeg` Cordis service: it runs ffmpeg and ffprobe over files on disk and reads what
 * ffprobe reports. Feature components call it from their operations. The runner never stores anything: a command reads
 * input files by path and writes its declared outputs into a directory the caller gives, usually the operation's
 * scratch directory, and the operation imports the outputs into the asset pool. `lastFrame` takes video bytes instead
 * and works in a temporary directory that it removes.
 *
 * At most `concurrency` processes run at once across `run`, `probe`, `lastFrame` and `available`; further calls wait in
 * first-in-first-out order. Commands run through `ctx.subprocess` when that service is mounted (dsh's managed process
 * range), else through Node's `child_process`, so the service also works in a bare Cordis root such as a test.
 *
 * Ported from DreamVerse `@dv/ffmpeg`; see THIRD_PARTY_NOTICES.md.
 *
 * @module @cs/ffmpeg
 */
import { execFile } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import z from "@deepseek-ai/schemastery";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The ffmpeg runner: ffmpeg and ffprobe over files on disk. */
    csFfmpeg: CsFfmpeg;
  }
}

/** `csFfmpeg` plugin configuration. */
export interface Config {
  /** The ffmpeg binary; a bare name is resolved on `PATH`. */
  ffmpegPath: string;
  /** The ffprobe binary; a bare name is resolved on `PATH`. */
  ffprobePath: string;
  /** Bytes of stdout and stderr kept per command; longer output is truncated to its tail. */
  outputLimitBytes: number;
  /** How many ffmpeg or ffprobe processes may run at once; further calls wait their turn. */
  concurrency: number;
}

/** Runtime schema of {@link Config}. */
export const Config: z<Partial<Config>, Config> = z.object({
  ffmpegPath: z.string().default("ffmpeg"),
  ffprobePath: z.string().default("ffprobe"),
  outputLimitBytes: z.number().default(1_048_576),
  concurrency: z.natural().min(1).default(2),
});

/** One command over files. */
export interface FfmpegRequest {
  /**
   * The program and its arguments. `argv[0]` of `ffmpeg` or `ffprobe` maps to the configured binaries. `{{in:<n>}}`
   * expands to the n-th input path and `{{out:<name>}}` to the path of a declared output inside `dir`.
   */
  argv: readonly string[];
  /** Absolute paths of the input files. */
  inputs: readonly string[];
  /** The file names the command must write into `dir`. */
  outputs: readonly string[];
  /** An existing directory: the command's working directory, where it writes its outputs and `files`. */
  dir: string;
  /**
   * Text files to write into `dir` before the command runs, for programs that read a list file; `{{in:<n>}}` and
   * `{{out:<name>}}` expand inside the content too.
   */
  files?: readonly { name: string; content: string }[];
  /** Milliseconds before the command is terminated; defaults to ten minutes. */
  timeoutMs?: number;
}

/** What a command left behind. */
export interface FfmpegResult {
  /** The absolute paths of the declared outputs, in declaration order. */
  outputs: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** What ffprobe reports about a file. */
export interface ProbeResult {
  durationSec: number | null;
  /** The first video stream's own duration; it can be shorter than `durationSec` when the audio track runs longer. */
  videoDurationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  /** The first video stream's codec name, or null for audio-only files. */
  codec: string | null;
}

/** A command exited non-zero, referenced an unknown placeholder, or did not write a declared output. */
export class FfmpegError extends Error {
  /** The command's whole captured stderr; empty when the command did not run. */
  readonly stderr: string;

  /**
   * @param message - what went wrong, with the last lines of stderr for a failed command.
   * @param stderr - the command's whole captured stderr; empty when the command did not run.
   */
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "FfmpegError";
    this.stderr = stderr;
  }
}

const DEFAULT_TIMEOUT_MS = 600_000;
const PLACEHOLDER = /\{\{(in|out):([^}]+)\}\}/g;

/** The captured outcome of one process. */
interface Outcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * @param text - a stream's text.
 * @param lines - how many trailing lines to keep.
 * @returns the last lines of the text, for error messages.
 */
function tail(text: string, lines = 6): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/**
 * @param value - any value.
 * @returns whether it is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * @param value - a JSON value that should be a number.
 * @returns the number, or undefined when it is anything else.
 */
function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * @param value - a JSON value that should be a string.
 * @returns the string, or undefined when it is anything else.
 */
function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * @param value - a duration as ffprobe prints it, a decimal string.
 * @returns the seconds, or null when it is absent or not a finite number.
 */
function secondsOf(value: unknown): number | null {
  const text = stringOf(value);
  if (text === undefined) return null;
  const seconds = Number(text);
  return Number.isFinite(seconds) ? seconds : null;
}

/** Run ffmpeg and ffprobe over files. */
export default class CsFfmpeg extends Service {
  static Config = Config;

  private readonly config: Config;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private availability: Promise<boolean> | undefined;

  constructor(ctx: Context, config: Config) {
    super(ctx, "csFfmpeg");
    this.config = config;
  }

  /**
   * Whether the ffmpeg binary can be started. The first call runs `ffmpeg -version`; the answer is kept for the life
   * of the service. Callers use it to skip work when ffmpeg is not installed.
   * @returns true when `ffmpeg -version` ran and exited with zero.
   */
  available(): Promise<boolean> {
    this.availability ??= this.execute(this.config.ffmpegPath, ["-version"], tmpdir(), 10_000).then(
      (outcome) => outcome.exitCode === 0,
      () => false,
    );
    return this.availability;
  }

  /**
   * Run one command in `request.dir` with its placeholders expanded, and check that it wrote every declared output.
   * @param request - the command, its input paths, its declared outputs, and its directory.
   * @returns the output paths and the captured streams.
   * @throws FfmpegError when a placeholder names an unknown input or output, the command exits non-zero, or it leaves
   *   a declared output unwritten.
   */
  async run(request: FfmpegRequest): Promise<FfmpegResult> {
    const expand = (text: string): string =>
      text.replace(PLACEHOLDER, (_match, kind: string, key: string) => {
        if (kind === "in") {
          const path = request.inputs[Number(key)];
          if (path === undefined) {
            throw new FfmpegError(
              `Command references input ${key}, but only ${request.inputs.length} were given.`,
              "",
            );
          }
          return path;
        }
        if (!request.outputs.includes(key)) {
          throw new FfmpegError(`Command references undeclared output '${key}'.`, "");
        }
        return join(request.dir, key);
      });
    const argv = request.argv.map(expand);
    for (const file of request.files ?? []) {
      writeFileSync(join(request.dir, file.name), expand(file.content));
    }
    const program = this.resolveProgram(argv[0] ?? "");
    const outcome = await this.execute(
      program,
      argv.slice(1),
      request.dir,
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (outcome.exitCode !== 0) {
      throw new FfmpegError(
        `${argv[0]} exited with ${outcome.exitCode}: ${tail(outcome.stderr)}`,
        outcome.stderr,
      );
    }
    const written = new Set(readdirSync(request.dir));
    const outputs = request.outputs.map((name) => {
      if (!written.has(name)) {
        throw new FfmpegError(
          `${argv[0]} did not write declared output '${name}'.`,
          outcome.stderr,
        );
      }
      return join(request.dir, name);
    });
    return { outputs, stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode };
  }

  /**
   * Read duration, dimensions, audio presence, and video codec of a file.
   * @param path - the file.
   * @returns the probe result; fields ffprobe cannot determine are null.
   * @throws FfmpegError when ffprobe fails, for example on a file that is not audio, video or an image.
   */
  async probe(path: string): Promise<ProbeResult> {
    const result = await this.run({
      argv: [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "{{in:0}}",
      ],
      inputs: [path],
      outputs: [],
      dir: tmpdir(),
    });
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      throw new FfmpegError(
        `ffprobe printed output that is not JSON: ${tail(result.stdout)}`,
        result.stderr,
      );
    }
    const root = isRecord(json) ? json : {};
    const streams = Array.isArray(root["streams"]) ? root["streams"].filter(isRecord) : [];
    const video = streams.find((stream) => stream["codec_type"] === "video");
    const format = isRecord(root["format"]) ? root["format"] : undefined;
    const duration = secondsOf(format?.["duration"]) ?? secondsOf(video?.["duration"]);
    return {
      durationSec: duration,
      videoDurationSec: secondsOf(video?.["duration"]),
      width: numberOf(video?.["width"]) ?? null,
      height: numberOf(video?.["height"]) ?? null,
      hasAudio: streams.some((stream) => stream["codec_type"] === "audio"),
      codec: stringOf(video?.["codec_name"]) ?? null,
    };
  }

  /**
   * Read the last frame of a video given as bytes. The video goes to a temporary directory that the method removes
   * before it settles, so the caller gives no directory and keeps no file.
   * @param video - the MP4 bytes.
   * @returns the last frame as PNG bytes.
   * @throws FfmpegError when ffmpeg cannot read the video or writes no frame.
   */
  async lastFrame(video: Buffer): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "cs-ffmpeg-"));
    try {
      const input = join(dir, "video.mp4");
      await writeFile(input, video);
      // -sseof seeks into the final second, and -update keeps overwriting the one output frame until the last.
      const argv = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-sseof",
        "-1",
        "-i",
        "{{in:0}}",
        "-update",
        "1",
        "{{out:last.png}}",
      ];
      const result = await this.run({ argv, inputs: [input], outputs: ["last.png"], dir });
      const [still] = result.outputs;
      if (still === undefined) throw new FfmpegError("ffmpeg wrote no frame.", result.stderr);
      return await readFile(still);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * @param name - the program named in a command.
   * @returns the configured binary for `ffmpeg` or `ffprobe`; any other program runs as named.
   */
  private resolveProgram(name: string): string {
    if (name === "ffmpeg") return this.config.ffmpegPath;
    if (name === "ffprobe") return this.config.ffprobePath;
    return name;
  }

  /**
   * Take a process slot, waiting in first-in-first-out order while `concurrency` processes run.
   * @returns a function that gives the slot back to the next waiting call.
   */
  private async acquire(): Promise<() => void> {
    if (this.running >= this.config.concurrency) {
      // The slot is handed over by `release` without being given up, so `running` stays counted.
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      this.running += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) this.running -= 1;
      else next();
    };
  }

  /**
   * Run one process within the concurrency limit: through the harness subprocess service when it is mounted, else
   * through `child_process`.
   */
  private async execute(
    program: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<Outcome> {
    const release = await this.acquire();
    try {
      const subprocess = this.ctx.get("subprocess");
      if (subprocess !== undefined) {
        return await this.executeManaged(subprocess, program, args, cwd, timeoutMs);
      }
      return await new Promise<Outcome>((resolve) => {
        const options = {
          cwd,
          timeout: timeoutMs,
          maxBuffer: this.config.outputLimitBytes,
          encoding: "utf8",
        } as const;
        execFile(program, args, options, (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({
            stdout,
            stderr: error === null ? stderr : `${stderr}\n${error.message}`.trim(),
            exitCode,
          });
        });
      });
    } finally {
      release();
    }
  }

  /** Spawn through `ctx.subprocess` with collected output and a timeout that terminates the managed range. */
  private async executeManaged(
    subprocess: SubprocessRuntime,
    program: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<Outcome> {
    const limit = { maxBytes: this.config.outputLimitBytes };
    const handle = subprocess.spawn({
      argv: [program, ...args],
      cwd,
      stdio: { stdin: "ignore", stdout: limit, stderr: limit },
      graceMs: 5_000,
    });
    const timer = setTimeout(() => {
      handle.terminate();
    }, timeoutMs);
    try {
      const outcome = await handle.done;
      return {
        stdout: handle.collected.stdout?.readFrom(0).text ?? "",
        stderr: handle.collected.stderr?.readFrom(0).text ?? "",
        exitCode: outcome.exitCode ?? 1,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
