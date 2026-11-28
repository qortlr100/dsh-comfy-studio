// Host scenario: the project layer inside a real dsh process. It registers a throwaway
// component, makes the folder the test prepared a project, runs an operation twice, moves the
// history position back and forth, and reports what it saw at each step.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-projection";
import type {} from "@deepseek-ai/dsh-tools";
// Value imports on purpose: the scenario must get the very module dsh loaded through the
// profile's bundle link, or `instanceof` below fails.
import { ProjectError } from "@cs/project";
import type { OperationSpec, RecordOrigin, Reducer, SessionId } from "@cs/project";
import { PROJECT_DIR } from "@cs/project/folder";

interface NoteSlice {
  texts: string[];
}

declare module "@cs/project/types" {
  interface ComponentStates {
    /** The slice of this scenario's throwaway component. */
    probe_note?: NoteSlice;
  }
}

export interface ProjectLifecycleInput {
  /** An existing empty folder that becomes the project. */
  folder: string;
}

export interface ProjectLifecycleResult {
  projectId: string;
  projectPath: string;
  listedProjects: string[];
  /** The project of a chat session whose working directory is the folder, before and after. */
  sessionProjectBefore: string | null;
  sessionProjectAfter: string | null;
  /** The state of the "what the agent saw" projection for that session. */
  sight: unknown;
  recordLines: { afterCreate: number; afterRuns: number; afterMoves: number };
  runStatuses: Array<string | null>;
  notes: { afterRuns: string[]; afterUndo: string[]; afterRedo: string[] };
  positions: { afterRuns: string; afterUndo: string; afterRedo: string; tip: string };
  history: Array<{ operation: string | null; place: string; status: string }>;
  toolNames: string[];
  /** The refusal of a second registration of the same component key. */
  duplicate: { sameModule: boolean; code: string | null };
  newFolder: string;
  home: string;
}

const COMPONENT = "probe_note";
const OPERATION = "probe_note.add";

const ORIGIN: RecordOrigin = {
  actor: "user",
  surface: "api",
  session: null,
  turn: null,
  tool_call: null,
  intent: "integration test",
};

const noteReducer: Reducer<"probe_note"> = {
  initial: () => ({ texts: [] }),
  reduce(slice, record) {
    if (record.operation !== OPERATION || record.status !== "done") return slice;
    return { texts: [...(slice?.texts ?? []), String(record.params["text"])] };
  },
};

const noteAdd: OperationSpec = {
  name: OPERATION,
  component: COMPONENT,
  version: "1",
  description: "Add a note to the project. Exists only in the integration test.",
  params: { text: { type: "string", required: true, description: "The note." } },
  inputs: {},
  outputs: [],
  deterministic: false,
  resource: "none",
  summarize: (record) => `added the note ${String(record.params["text"])}`,
  execute: () => Promise.resolve({ outputs: [] }),
};

function lineCount(file: string): number {
  return readFileSync(file, "utf8").trimEnd().split("\n").length;
}

export const inject = ["csProject", "tools", "sessions", "sessionProjections"];

export default async function projectLifecycle(
  ctx: Context,
  input: ProjectLifecycleInput,
): Promise<ProjectLifecycleResult> {
  const service = ctx.csProject;
  const notes = (project: Parameters<typeof service.getState>[0]): string[] =>
    service.getState(project).components.probe_note?.texts ?? [];

  const disposers = [service.registerComponent(COMPONENT)];
  try {
    disposers.push(service.registerReducer(COMPONENT, noteReducer));
    disposers.push(service.registerOperation(noteAdd));

    let duplicate: ProjectLifecycleResult["duplicate"] = { sameModule: false, code: null };
    try {
      service.registerComponent(COMPONENT)();
    } catch (error) {
      duplicate =
        error instanceof ProjectError
          ? { sameModule: true, code: error.code }
          : { sameModule: false, code: null };
    }

    // A chat that already runs in the folder; it belongs to the project once there is one.
    const session = ctx.sessions.create(undefined, { meta: { cwd: input.folder } });
    // The project layer's session id is the dsh session id under its own compile-time brand.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const sessionId = String(session.id) as SessionId;
    const sessionProjectBefore = service.sessionProject(sessionId);

    const info = await service.createProject(input.folder, "Probe project", ORIGIN);
    const records = join(info.path, PROJECT_DIR, "records.jsonl");
    const afterCreate = lineCount(records);

    const runStatuses: Array<string | null> = [];
    for (const text of ["first", "second"]) {
      const result = await service.run({
        ...ORIGIN,
        project: info.id,
        operation: OPERATION,
        params: { text },
        inputs: [],
      });
      runStatuses.push(result.record?.status ?? null);
    }
    const afterRuns = lineCount(records);
    const notesAfterRuns = notes(info.id);
    const lineAfterRuns = service.line(info.id);

    const lineAfterUndo = await service.undo(info.id);
    const notesAfterUndo = notes(info.id);
    const lineAfterRedo = await service.redo(info.id);
    const notesAfterRedo = notes(info.id);

    return {
      projectId: info.id,
      projectPath: info.path,
      listedProjects: service.listProjects().map((project) => project.id),
      sessionProjectBefore,
      sessionProjectAfter: service.sessionProject(sessionId),
      // The registry-level read is deprecated in favor of the registrant's own handle, which
      // the project layer keeps to itself. It is the only way to see from outside that the
      // projection is registered and folds this session.
      // oxlint-disable-next-line typescript/no-deprecated
      sight: ctx.sessionProjections.stateOf(session, "csProjectSight"),
      recordLines: { afterCreate, afterRuns, afterMoves: lineCount(records) },
      runStatuses,
      notes: { afterRuns: notesAfterRuns, afterUndo: notesAfterUndo, afterRedo: notesAfterRedo },
      positions: {
        afterRuns: lineAfterRuns.at,
        afterUndo: lineAfterUndo.at,
        afterRedo: lineAfterRedo.at,
        tip: lineAfterRedo.tip,
      },
      history: service.listHistory({ project: info.id }).map((entry) => ({
        operation: entry.record.operation,
        place: entry.place,
        status: entry.record.status,
      })),
      toolNames: ctx.tools.definitions().map((definition) => definition.name),
      duplicate,
      newFolder: await service.newProjectFolder("probe"),
      home: homedir(),
    };
  } finally {
    for (const dispose of disposers.toReversed()) dispose();
  }
}
