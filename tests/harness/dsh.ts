// Launches the real dsh with our bundle in a throwaway home and takes it down again.
// Spec: docs/archive/PLAN_1-2.md "틀의 명세 — `tests/harness/`".
//
// The login URL dsh prints carries a token. It leaves this module only as `DshInstance.url`;
// every text this module produces (errors, `output()`) goes through `redactLoginUrls`.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { PROFILE, dshCommand, ensureProfile } from "../../scripts/dsh-env.ts";

// The trailing whitespace matters: the line is only complete once its newline has arrived.
const READY_LINE = /dsh web: (https?:\/\/\S+)\s/;
const INACTIVE_MARKER = "did not activate";
/** dsh prints its warnings right around the URL line; give stderr a moment to arrive. */
const SETTLE_AFTER_READY_MS = 50;
/** dsh's own shutdown budget is 5 s; past this the process is considered stuck. */
const STOP_GRACE_MS = 8_000;
/** How long to wait for the output pipes after the process itself is gone. */
const DRAIN_AFTER_EXIT_MS = 1_000;

/**
 * Set by global-setup.ts to the folder that holds everything one test run creates: temp homes,
 * scenario folders and one file per running dsh (named by pid). The global teardown kills
 * what is still listed there and deletes the folder.
 */
export const RUN_DIR_ENV = "CS_TEST_RUN_DIR";
export const PID_DIR = "pids";

/** Parent for temp folders: the run folder under Vitest, the OS temp dir otherwise. */
export function tempParent(): string {
  return process.env[RUN_DIR_ENV] || tmpdir();
}

/** Process variables dsh may see. Everything else (model keys above all) stays out. */
const PASSED_ENV = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
] as const;

/** Replaces every http(s) URL, and any stray `token=` value, so the login token never leaks. */
export function redactLoginUrls(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\btoken=[^\s&"'<>]+/g, "token=<redacted>");
}

export interface TestHome {
  /** DSH_HOME. Its profile comfy-studio links the bundle of this checkout. */
  readonly dshHome: string;
  /** HOME of the dsh process. */
  readonly userHome: string;
  /** Deletes the temp folder holding both. Safe to call more than once. */
  remove(): void;
}

export interface LaunchOptions {
  /** Created when absent and deleted on stop(). A given home is left in place. */
  home?: TestHome;
  /** `--patch` files, in this order. */
  patches?: readonly string[];
  /** Web app arguments, appended after `--no-open --port 0`. */
  args?: readonly string[];
  /** Added on top of the allowlisted variables. */
  env?: Readonly<Record<string, string>>;
  /** Default 20_000. */
  startupTimeoutMs?: number;
  /** Default false: a row whose `apply` failed fails the launch, or stop() at the latest. */
  allowInactiveEntries?: boolean;
}

export interface DshExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface DshInstance {
  /** Login URL with the token. Never print it. */
  readonly url: string;
  readonly home: TestHome;
  /** stdout and stderr so far, URLs redacted. */
  output(): string;
  /** Settles once the process is gone and its output is drained. Never rejects. */
  readonly exited: Promise<DshExit>;
  /**
   * Takes dsh down and removes a home this launch created. Safe to call more than once.
   * Rejects once if dsh reported an inactive plugin entry after the launch had been accepted.
   */
  stop(): Promise<void>;
}

// For a process that ends on its own (a script, a worker that returns normally). Vitest stops
// its workers with a signal, which skips "exit" handlers: what a timed-out test leaves behind
// is cleaned up by the global teardown through the run folder instead.
const liveChildren = new Set<ChildProcess>();
const liveHomeRoots = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of liveChildren) child.kill("SIGKILL");
    for (const root of liveHomeRoots) rmSync(root, { recursive: true, force: true });
  });
}

export function createTestHome(): TestHome {
  installExitHook();
  const root = mkdtempSync(join(tempParent(), "cs-dsh-test-"));
  liveHomeRoots.add(root);
  const remove = (): void => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    liveHomeRoots.delete(root);
  };

  const dshHome = join(root, "dsh-home");
  const userHome = join(root, "user-home");
  try {
    mkdirSync(dshHome);
    mkdirSync(userHome);
    // Runs with this process's own environment: it calls pnpm, which uses its usual store.
    ensureProfile(dshHome);
  } catch (error) {
    remove();
    throw error;
  }
  return { dshHome, userHome, remove };
}

function childEnv(home: TestHome, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = home.userHome;
  env.DSH_HOME = home.dshHome;
  return { ...env, ...extra };
}

/** Lists the child in the run folder so the global teardown can find it; returns the undo. */
function registerPid(child: ChildProcess): () => void {
  const runDir = process.env[RUN_DIR_ENV];
  if (!runDir || child.pid === undefined) return () => {};
  const file = join(runDir, PID_DIR, String(child.pid));
  try {
    writeFileSync(file, "");
  } catch {
    // The run folder is gone (teardown already ran); there is nobody left to read the list.
    return () => {};
  }
  return () => rmSync(file, { force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeExit(exit: DshExit): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${String(exit.code)}`;
}

function failure(summary: string, output: string): Error {
  return new Error(`${summary}\n--- dsh output (URLs redacted) ---\n${output.trimEnd()}`);
}

type StartupOutcome =
  { kind: "ready"; url: string } | { kind: "exited"; exit: DshExit } | { kind: "timeout" };

export async function launchDsh(options: LaunchOptions = {}): Promise<DshInstance> {
  installExitHook();
  const ownsHome = options.home === undefined;
  const home = options.home ?? createTestHome();
  const startupTimeoutMs = options.startupTimeoutMs ?? 20_000;

  const args = ["--profile", PROFILE];
  // Launcher options must come before the web app's own options, or dsh rejects them.
  for (const patch of options.patches ?? []) args.push("--patch", patch);
  args.push("--no-open", "--port", "0", ...(options.args ?? []));

  let child: ChildProcess;
  try {
    const command = dshCommand(args);
    child = spawn(command.command, command.args, {
      env: childEnv(home, options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (ownsHome) home.remove();
    throw error;
  }
  liveChildren.add(child);
  const unregisterPid = registerPid(child);
  const forget = (): void => {
    liveChildren.delete(child);
    unregisterPid();
  };

  let buffer = "";
  const output = (): string => redactLoginUrls(buffer);

  const ready = Promise.withResolvers<string>();
  let readySeen = false;
  const append = (text: string): void => {
    buffer += text;
    if (readySeen) return;
    const url = READY_LINE.exec(buffer)?.[1];
    if (url !== undefined) {
      readySeen = true;
      ready.resolve(url);
    }
  };
  // Each stream is decoded on its own and joins the shared buffer in whole lines only, so a
  // chunk boundary or the other stream can never cut a line (the URL above all) in two.
  const collect = (stream: Readable | null): void => {
    if (stream === null) return;
    stream.setEncoding("utf8");
    let pending = "";
    stream.on("data", (chunk: string) => {
      pending += chunk;
      const end = pending.lastIndexOf("\n");
      if (end === -1) return;
      append(pending.slice(0, end + 1));
      pending = pending.slice(end + 1);
    });
    stream.on("end", () => {
      if (pending !== "") append(`${pending}\n`);
      pending = "";
    });
  };
  collect(child.stdout);
  collect(child.stderr);

  const exited = new Promise<DshExit>((resolve) => {
    const settle = (exit: DshExit): void => {
      forget();
      resolve(exit);
    };
    // "close" comes after the output pipes are drained, so nothing dsh printed is lost. A
    // descendant holding the pipes open would hold it back forever, hence the bound after
    // "exit".
    child.once("close", (code, signal) => settle({ code, signal }));
    child.once("exit", (code, signal) => {
      setTimeout(() => settle({ code, signal }), DRAIN_AFTER_EXIT_MS).unref();
    });
    child.once("error", (error) => {
      append(`[harness] could not run dsh: ${error.message}\n`);
      settle({ code: null, signal: null });
    });
  });

  let shuttingDown: Promise<void> | undefined;
  const shutDown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        let timer: NodeJS.Timeout | undefined;
        const stuck = await Promise.race([
          exited.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), STOP_GRACE_MS);
          }),
        ]);
        clearTimeout(timer);
        if (stuck) child.kill("SIGKILL");
      }
      await exited;
      if (ownsHome) home.remove();
    })();
    return shuttingDown;
  };

  let startupTimer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race<StartupOutcome>([
    ready.promise.then((url): StartupOutcome => ({ kind: "ready", url })),
    exited.then((exit): StartupOutcome => ({ kind: "exited", exit })),
    new Promise<StartupOutcome>((resolve) => {
      startupTimer = setTimeout(() => resolve({ kind: "timeout" }), startupTimeoutMs);
    }),
  ]);
  clearTimeout(startupTimer);

  if (outcome.kind === "exited") {
    await shutDown();
    throw failure(`dsh exited before it was ready (${describeExit(outcome.exit)}).`, output());
  }
  if (outcome.kind === "timeout") {
    await shutDown();
    throw failure(`dsh printed no "dsh web:" line within ${startupTimeoutMs} ms.`, output());
  }

  const inactiveFailure = (): Error =>
    failure(
      `dsh started but a plugin entry ${INACTIVE_MARKER} (pass allowInactiveEntries to accept).`,
      output(),
    );
  const tolerateInactive = options.allowInactiveEntries ?? false;

  await delay(SETTLE_AFTER_READY_MS);
  if (!tolerateInactive && buffer.includes(INACTIVE_MARKER)) {
    await shutDown();
    throw inactiveFailure();
  }

  let inactiveReported = false;
  const stop = async (): Promise<void> => {
    await shutDown();
    // The warning and the URL travel on different pipes, so on a loaded machine the warning
    // can arrive after the check above. By now all output is in: look once more.
    if (!tolerateInactive && !inactiveReported && buffer.includes(INACTIVE_MARKER)) {
      inactiveReported = true;
      throw inactiveFailure();
    }
  };

  return { url: outcome.url, home, output, exited, stop };
}
