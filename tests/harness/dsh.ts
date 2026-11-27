// Launches the real dsh with our bundle in a throwaway home and takes it down again.
// Spec: docs/archive/PLAN_1-2.md "틀의 명세 — `tests/harness/`".
//
// The login URL dsh prints carries a token. It leaves this module only as `DshInstance.url`;
// every text this module produces (errors, `output()`) goes through `redactLoginUrls`.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE, dshCommand, ensureProfile } from "../../scripts/dsh-env.ts";

// The trailing whitespace matters: output arrives in chunks, and a chunk may end mid-URL.
const READY_LINE = /dsh web: (https?:\/\/\S+)\s/;
const INACTIVE_MARKER = "did not activate";
/** dsh prints its warnings right around the URL line; give stderr a moment to arrive. */
const SETTLE_AFTER_READY_MS = 50;
/** dsh's own shutdown budget is 5 s; past this the process is considered stuck. */
const STOP_GRACE_MS = 8_000;

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
  /** Default 30_000. */
  startupTimeoutMs?: number;
  /** Default false: a row whose `apply` failed fails the launch. */
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
  /** Safe to call more than once. */
  stop(): Promise<void>;
}

// Last line of defence for a run cut short (a crashed worker, an aborted Vitest): whatever is
// still registered here is killed and deleted when this process exits.
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
  const root = mkdtempSync(join(tmpdir(), "cs-dsh-test-"));
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
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;

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

  let buffer = "";
  const output = (): string => redactLoginUrls(buffer);

  const ready = Promise.withResolvers<string>();
  let readySeen = false;
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    if (readySeen) return;
    const url = READY_LINE.exec(buffer)?.[1];
    if (url !== undefined) {
      readySeen = true;
      ready.resolve(url);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const exited = new Promise<DshExit>((resolve) => {
    // "close" rather than "exit": it fires after the output pipes are drained.
    child.once("close", (code, signal) => {
      liveChildren.delete(child);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      buffer += `\n[harness] could not run dsh: ${error.message}\n`;
      liveChildren.delete(child);
      resolve({ code: null, signal: null });
    });
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
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
    return stopping;
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
    await stop();
    throw failure(`dsh exited before it was ready (${describeExit(outcome.exit)}).`, output());
  }
  if (outcome.kind === "timeout") {
    await stop();
    throw failure(`dsh printed no "dsh web:" line within ${startupTimeoutMs} ms.`, output());
  }

  await delay(SETTLE_AFTER_READY_MS);
  if (!options.allowInactiveEntries && buffer.includes(INACTIVE_MARKER)) {
    await stop();
    throw failure(
      `dsh started but a plugin entry ${INACTIVE_MARKER} (pass allowInactiveEntries to accept).`,
      output(),
    );
  }

  return { url: outcome.url, home, output, exited, stop };
}
