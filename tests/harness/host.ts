// Runs a scenario module inside a real dsh process through the probe plugin and hands back
// what it returned. Spec: docs/archive/PLAN_1-2.md "`host.ts`와 `probe/index.ts` — 호스트 시나리오".
//
// A scenario module (loaded by dsh's Node, so erasable syntax only):
//   export const inject = ["tools"];                       // services to wait for, optional
//   export default async function (ctx, input) { … }       // the result travels as JSON

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchDsh, redactLoginUrls, tempParent } from "./dsh.ts";
import type { DshInstance, TestHome } from "./dsh.ts";
import type { ProbeReport } from "./probe/index.ts";

export interface HostScenarioOptions {
  /** Travels to the scenario as JSON, through a file. */
  input?: unknown;
  home?: TestHome;
  /** Placed before the probe's patch. */
  patches?: readonly string[];
  /** How long to wait for the report after the URL line. Default 20_000. */
  timeoutMs?: number;
}

const PROBE_PATH = fileURLToPath(new URL("./probe/index.ts", import.meta.url));
const POLL_MS = 25;

function scenarioUrl(scenario: string | URL): string {
  if (scenario instanceof URL) return scenario.href;
  if (scenario.startsWith("file:")) return scenario;
  return pathToFileURL(scenario).href;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failure(summary: string, dsh: DshInstance): Error {
  return new Error(`${summary}\n--- dsh output (URLs redacted) ---\n${dsh.output().trimEnd()}`);
}

/** Polls for the report file until it appears, dsh exits or the deadline passes. */
async function waitForReport(
  report: string,
  dsh: DshInstance,
  deadline: number,
): Promise<"report" | "exited" | "timeout"> {
  for (;;) {
    if (existsSync(report)) return "report";
    if (Date.now() >= deadline) return "timeout";
    const event = await Promise.race([
      delay(POLL_MS).then(() => "tick" as const),
      dsh.exited.then(() => "exited" as const),
    ]);
    if (event === "exited") return existsSync(report) ? "report" : "exited";
  }
}

function isProbeReport(value: unknown): value is ProbeReport {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return true;
  if (value.ok !== false || !("error" in value)) return false;
  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export async function runHostScenario<T = unknown>(
  scenario: string | URL,
  options: HostScenarioOptions = {},
): Promise<T> {
  // With launchDsh's 20 s startup budget and 8 s stop budget this stays under the 60 s the
  // integration project gives a test, so the cleanup below still runs when everything is slow.
  const timeoutMs = options.timeoutMs ?? 20_000;
  const dir = mkdtempSync(join(tempParent(), "cs-dsh-test-scenario-"));
  try {
    const report = join(dir, "report.json");
    const go = join(dir, "go");
    const patch = join(dir, "probe.patch.yml");
    // The input goes through a file rather than the row's config: dsh's loader interprets
    // config values (expressions, references), and the input must arrive as plain JSON.
    let input: string | undefined;
    if (options.input !== undefined) {
      input = join(dir, "input.json");
      writeFileSync(input, JSON.stringify(options.input));
    }
    const row = {
      id: "cs-test-probe",
      name: PROBE_PATH,
      config: { scenario: scenarioUrl(scenario), report, go, input },
    };
    // JSON is YAML too, so dsh reads this as is.
    writeFileSync(patch, `${JSON.stringify([{ insert: [row] }])}\n`);

    const dsh = await launchDsh({
      home: options.home,
      patches: [...(options.patches ?? []), patch],
    });
    try {
      writeFileSync(go, "");

      const outcome = await waitForReport(report, dsh, Date.now() + timeoutMs);
      if (outcome === "exited") throw failure("dsh exited before the scenario reported.", dsh);
      if (outcome === "timeout") {
        throw failure(`The scenario did not report within ${timeoutMs} ms.`, dsh);
      }

      const parsed: unknown = JSON.parse(readFileSync(report, "utf8"));
      if (!isProbeReport(parsed)) throw failure("The probe wrote an unreadable report.", dsh);
      // The caller names the scenario's result type; the value is whatever JSON carried.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      if (parsed.ok) return parsed.value as T;

      const { name, message, stack } = parsed.error;
      const error = failure(
        `Scenario failed with ${name}: ${redactLoginUrls(message)}` +
          (stack === undefined ? "" : `\n--- scenario stack ---\n${redactLoginUrls(stack)}`),
        dsh,
      );
      error.name = name;
      throw error;
    } finally {
      await dsh.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
