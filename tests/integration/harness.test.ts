// The harness's own failure paths: a boot with a broken plugin must not pass as a clean boot.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { launchDsh, tempParent } from "../harness/dsh.ts";
import { MESSAGE } from "./fixtures/throwing-plugin.ts";

const PLUGIN_PATH = fileURLToPath(new URL("./fixtures/throwing-plugin.ts", import.meta.url));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A patch that adds one row whose `apply` throws. */
function throwingPatch(): string {
  const dir = mkdtempSync(join(tempParent(), "cs-dsh-test-patch-"));
  dirs.push(dir);
  const patch = join(dir, "throwing.patch.yml");
  writeFileSync(patch, JSON.stringify([{ insert: [{ id: "cs-throwing", name: PLUGIN_PATH }] }]));
  return patch;
}

describe("launchDsh with a plugin entry that fails", () => {
  test("rejects and shows which entry failed", async () => {
    const launch = launchDsh({ patches: [throwingPatch()] });
    await expect(launch).rejects.toThrow(/a plugin entry did not activate/);
    await expect(launch).rejects.toThrow(MESSAGE);
    await expect(launch).rejects.not.toThrow(/token=|https?:\/\//);
  });

  test("launches when told to accept it, and keeps the warning in the output", async () => {
    const dsh = await launchDsh({ patches: [throwingPatch()], allowInactiveEntries: true });
    try {
      expect(dsh.output()).toContain("1 entry did not activate");
      expect(dsh.output()).toContain("dsh web: <url>");
    } finally {
      await dsh.stop();
    }
    await expect(dsh.exited).resolves.toEqual({ code: 0, signal: null });
  });
});
