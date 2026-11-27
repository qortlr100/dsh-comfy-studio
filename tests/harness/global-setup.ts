// Runs once around the integration tests, in Vitest's main process.
//
// Before: builds the browser bundles (dsh refuses to start while lib/client.js is missing, and
// a stale one would test old code) and creates the run folder every temp home goes into.
// After: kills any dsh a test left running and deletes the run folder. A test's own cleanup
// does not always get to run: Vitest stops a worker with a signal once a test has timed out.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientBundles } from "../../scripts/build-client.ts";
import { checkoutRoot } from "../../scripts/dsh-env.ts";
import { PID_DIR, RUN_DIR_ENV } from "./dsh.ts";

/** False only when the process can be inspected and is clearly not a dsh of this run. */
function belongsToRun(pid: number, runDir: string): boolean {
  try {
    // Every dsh the harness starts has its DSH_HOME inside the run folder.
    return readFileSync(`/proc/${pid}/environ`, "utf8").includes(`DSH_HOME=${runDir}`);
  } catch {
    // No /proc (macOS) or the process is already gone; killing a missing pid is harmless.
    return true;
  }
}

function killLeftovers(runDir: string): void {
  let names: string[];
  try {
    names = readdirSync(join(runDir, PID_DIR));
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0 || !belongsToRun(pid, runDir)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export default async function setup(): Promise<() => void> {
  await buildClientBundles(checkoutRoot);

  const runDir = mkdtempSync(join(tmpdir(), "cs-dsh-test-run-"));
  mkdirSync(join(runDir, PID_DIR));
  // Workers are started after this and inherit the variable.
  process.env[RUN_DIR_ENV] = runDir;

  let cleaned = false;
  const cleanUp = (): void => {
    if (cleaned) return;
    cleaned = true;
    killLeftovers(runDir);
    rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
  };

  // Vitest skips this teardown when the run itself is interrupted (Ctrl+C, a killed runner),
  // so the same cleanup also hangs on the process ending and on the signals that end it.
  process.once("exit", cleanUp);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      cleanUp();
      // Hand the signal back so the run still ends the way it would have without us.
      process.kill(process.pid, signal);
    });
  }

  return cleanUp;
}
