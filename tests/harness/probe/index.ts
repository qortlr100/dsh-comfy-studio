// Test-only host plugin. `runHostScenario` puts it in a patch row (id `cs-test-probe`) by
// absolute path, so it runs inside the dsh process without being installed in the profile.
// Spec: docs/archive/PLAN_1-2.md "`host.ts`와 `probe/index.ts` — 호스트 시나리오".
//
// dsh's Node loads this file directly: erasable syntax only, and only `node:` modules as values.

import type { Context } from "@deepseek-ai/cordis";
import { existsSync, renameSync, writeFileSync } from "node:fs";

interface ProbeConfig {
  /** File URL of the scenario module. */
  scenario: string;
  /** Where the result goes. */
  report: string;
  /** Created by the harness once dsh printed its URL, that is once startup has settled. */
  go: string;
  input?: unknown;
}

export type ProbeReport =
  | { ok: true; value?: unknown }
  | { ok: false; error: { name: string; message: string; stack?: string } };

const POLL_MS = 25;

export function apply(ctx: Context, config: ProbeConfig): void {
  // At `apply` time other plugins are still loading (no tools are registered yet), so the
  // scenario waits for the harness's go file instead of running now.
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (!existsSync(config.go)) return;
      clearInterval(timer);
      // runAndReport turns every failure into a report and never rejects.
      void runAndReport(ctx, config);
    }, POLL_MS);
    return () => clearInterval(timer);
  });
}

async function runAndReport(ctx: Context, config: ProbeConfig): Promise<void> {
  let report: ProbeReport;
  try {
    const value = await runScenario(ctx, config);
    if (value !== undefined && JSON.stringify(value) === undefined) {
      throw new TypeError(`The scenario returned a value JSON cannot carry (${typeof value}).`);
    }
    report = { ok: true, value };
  } catch (error) {
    report = { ok: false, error: describeError(error) };
  }

  let text: string;
  try {
    text = JSON.stringify(report);
  } catch (error) {
    // Circular structures and BigInt values only fail here.
    text = JSON.stringify({ ok: false, error: describeError(error) } satisfies ProbeReport);
  }
  try {
    // Written aside and renamed, so the harness never reads half a file.
    writeFileSync(`${config.report}.tmp`, text);
    renameSync(`${config.report}.tmp`, config.report);
  } catch (error) {
    console.error("cs-test-probe: could not write the report:", error);
  }
}

async function runScenario(ctx: Context, config: ProbeConfig): Promise<unknown> {
  const module: unknown = await import(config.scenario);
  if (typeof module !== "object" || module === null) {
    throw new TypeError(`${config.scenario} did not load as a module.`);
  }
  const main: unknown = Reflect.get(module, "default");
  if (typeof main !== "function") {
    throw new TypeError(`${config.scenario} has no default export function.`);
  }
  const inject: unknown = Reflect.get(module, "inject");
  const deps = Array.isArray(inject) ? inject.map(String) : [];
  const run = (inner: Context): unknown => Reflect.apply(main, undefined, [inner, config.input]);

  if (deps.length === 0) return await run(ctx);
  return await withServices(ctx, deps, run);
}

function withServices(
  ctx: Context,
  deps: readonly string[],
  body: (inner: Context) => unknown,
): Promise<unknown> {
  // Shows up in the dsh output when a missing service makes the harness time out.
  console.error(`cs-test-probe: waiting for services ${deps.join(", ")}`);
  return new Promise((resolve, reject) => {
    let started = false;
    // The fiber's own promise is not needed: the callback settles ours.
    void ctx.inject([...deps], (inner) => {
      if (started) return;
      started = true;
      Promise.resolve()
        .then(() => body(inner))
        .then(resolve, reject);
    });
  });
}

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack === undefined
      ? { name: error.name, message: error.message }
      : { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "NonError", message: String(error) };
}
