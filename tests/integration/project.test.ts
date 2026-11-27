// The project layer (@cs/project) loaded by a real dsh through our bundle: a project is made,
// operations are recorded and reduced, undo and redo move the state, and every operation is a
// tool in dsh's registry. Spec: docs/archive/PLAN_2-0.md "조합 시험".

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempParent } from "../harness/dsh.ts";
import { runHostScenario } from "../harness/host.ts";
import type { ProjectFolderResult } from "./scenarios/project-folder.ts";
import type { ProjectLifecycleResult } from "./scenarios/project-lifecycle.ts";

const SCENARIO = new URL("./scenarios/project-lifecycle.ts", import.meta.url);
const FOLDER_SCENARIO = new URL("./scenarios/project-folder.ts", import.meta.url);

const PROJECT_TOOLS = [
  "cs_proj_create",
  "cs_proj_history_list",
  "cs_proj_redo",
  "cs_proj_rename",
  "cs_proj_stale_accept",
  "cs_proj_state",
  "cs_proj_undo",
  "cs_proj_wait",
];

interface RecordLine {
  id?: string;
  operation?: string;
  status?: string;
  params?: Record<string, unknown>;
}

function isRecordLine(value: unknown): value is RecordLine {
  return typeof value === "object" && value !== null;
}

function readLines(file: string): RecordLine[] {
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .map((line): unknown => JSON.parse(line))
    .filter(isRecordLine);
}

describe("project layer", () => {
  test("a project records operations, and undo and redo move its state", async () => {
    const folder = mkdtempSync(join(tempParent(), "cs-dsh-test-project-"));
    try {
      const result = await runHostScenario<ProjectLifecycleResult>(SCENARIO, {
        input: { folder },
      });

      // The folder is the project, registered as a dsh workspace.
      expect(result.projectPath).toBe(realpathSync(folder));
      expect(result.listedProjects).toEqual([result.projectId]);
      // A chat whose working directory is the folder belongs to the project once it exists.
      expect(result.sessionProjectBefore).toBeNull();
      expect(result.sessionProjectAfter).toBe(result.projectId);
      // dsh's projection registry accepted the "what the agent saw" projection and folds with it.
      expect(result.sight).toEqual({ from: null });

      // Every change is on disk: one line for the create, then record and update lines per run.
      const lines = readLines(join(folder, ".comfy-studio", "records.jsonl"));
      expect(lines[0]).toMatchObject({ operation: "proj.create", status: "done" });
      expect(result.recordLines.afterCreate).toBe(1);
      expect(result.recordLines.afterRuns).toBeGreaterThan(result.recordLines.afterCreate);
      const notes = lines.filter((line) => line.operation === "probe_note.add");
      expect(notes.map((line) => line.params)).toEqual([{ text: "first" }, { text: "second" }]);
      expect(result.runStatuses).toEqual(["done", "done"]);

      // The reducer sees the records; undo and redo move the position and write nothing.
      expect(result.notes.afterRuns).toEqual(["first", "second"]);
      expect(result.notes.afterUndo).toEqual(["first"]);
      expect(result.notes.afterRedo).toEqual(["first", "second"]);
      expect(result.recordLines.afterMoves).toBe(result.recordLines.afterRuns);
      expect(lines).toHaveLength(result.recordLines.afterRuns);
      expect(result.positions.afterUndo).toBe(notes[0]?.id);
      expect(result.positions.afterRuns).toBe(notes[1]?.id);
      expect(result.positions.afterRedo).toBe(result.positions.afterRuns);
      expect(result.positions.tip).toBe(result.positions.afterRuns);
      expect(result.history).toEqual([
        { operation: "probe_note.add", place: "current", status: "done" },
        { operation: "probe_note.add", place: "before", status: "done" },
        { operation: "proj.create", place: "before", status: "done" },
      ]);

      // Every operation is a tool in dsh's registry, beside the project layer's own tools.
      expect(result.toolNames).toContain("cs_probe_note_add");
      expect(result.toolNames.filter((name) => name.startsWith("cs_proj_")).toSorted()).toEqual(
        PROJECT_TOOLS,
      );

      // The scenario imported the same module instance that dsh loaded through the bundle.
      expect(result.duplicate).toEqual({ sameModule: true, code: "component_exists" });

      // New project folders go to the home directory of the dsh process, which the harness
      // points at a temp folder.
      expect(result.home).not.toBe(homedir());
      expect(result.newFolder).toBe(join(result.home, "comfy-studio-projects", "probe"));
    } finally {
      rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test("CS_PROJECTS_FOLDER moves the folder of new projects", async () => {
    const parent = mkdtempSync(join(tempParent(), "cs-dsh-test-projects-"));
    try {
      // The bundle's row hands the variable to the plugin as `projectsFolder`.
      const result = await runHostScenario<ProjectFolderResult>(FOLDER_SCENARIO, {
        env: { CS_PROJECTS_FOLDER: join(parent, "configured") },
      });
      expect(result.folder).toBe(join(parent, "configured", "probe"));

      // An empty variable counts as unset: the default folder in the home directory.
      const fallback = await runHostScenario<ProjectFolderResult>(FOLDER_SCENARIO, {
        env: { CS_PROJECTS_FOLDER: "" },
      });
      expect(fallback.folder).toMatch(/[\\/]comfy-studio-projects[\\/]probe$/);
      expect(fallback.folder.startsWith(homedir())).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
