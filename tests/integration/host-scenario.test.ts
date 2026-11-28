// Host side: scenarios run inside a real dsh process through the probe plugin.

import { describe, expect, test } from "vitest";
import { runHostScenario } from "../harness/host.ts";
import { SERVICE } from "./scenarios/missing-service.ts";
import { MESSAGE } from "./scenarios/throws.ts";
import type { ToolNamesResult } from "./scenarios/tool-names.ts";

const scenario = (name: string): URL => new URL(`./scenarios/${name}.ts`, import.meta.url);

describe("host scenarios", () => {
  test("a scenario reads ctx.tools and gets its input unchanged", async () => {
    const input = { text: "가나다", nested: { list: [1, 2, 3], flag: true, none: null } };
    const result = await runHostScenario<ToolNamesResult>(scenario("tool-names"), { input });

    expect(result.input).toEqual(input);
    // A global tool dsh registers on its own (Agent Teams' task board); it is only there once
    // startup has settled. (Until 1-4 this was working_directory, whose row the bundle disables.)
    expect(result.names).toContain("team_task_create");
  });

  test("a throwing scenario rejects with its message", async () => {
    const run = runHostScenario(scenario("throws"));
    await expect(run).rejects.toThrow(MESSAGE);
    await expect(run).rejects.toMatchObject({ name: "RangeError" });
  });

  test("a scenario waiting for a missing service times out and names the service", async () => {
    const run = runHostScenario(scenario("missing-service"), { timeoutMs: 1_500 });
    await expect(run).rejects.toThrow(/did not report within 1500 ms/);
    await expect(run).rejects.toThrow(`waiting for services ${SERVICE}`);
  });
});
