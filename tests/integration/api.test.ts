// The view API (@cs/api) served by a real dsh through our bundle and called from a page that
// logged in the way a user does: the browser reads a project's state, runs an operation, and
// the change arrives on the event stream. Spec: docs/PLAN_2-2.md "시험".

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { openPage } from "../harness/browser.ts";
import { launchDsh, tempParent } from "../harness/dsh.ts";
import { COMPONENT, LABEL, OPERATION } from "./fixtures/memo-component.ts";

const COMPONENT_PATH = fileURLToPath(new URL("./fixtures/memo-component.ts", import.meta.url));

interface Answer {
  status: number;
  body: unknown;
}

interface StreamEvent {
  kind: string;
  data: unknown;
}

/** What the page script reports back. */
interface PageReport {
  created: Answer;
  listed: Answer;
  operations: Answer;
  stateBefore: Answer;
  run: Answer;
  stateAfterRun: Answer;
  undo: Answer;
  stateAfterUndo: Answer;
  redo: Answer;
  history: Answer;
  summary: Answer;
  /** Every stream event up to the redo's `line`, in arrival order. */
  events: StreamEvent[];
  /** The number of events when each step had been seen on the stream. */
  marks: { ready: number; run: number; undo: number; redo: number };
}

// Runs inside the page, where `fetch` carries the login cookie. A string, because the test
// program is type-checked without the DOM library.
const PAGE_SCRIPT = `(async () => {
  const answerOf = async (response) => ({ status: response.status, body: await response.json() });
  const get = async (path) => answerOf(await fetch(path));
  const post = async (path, body) =>
    answerOf(
      await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const events = [];
  const seen = (test) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (test()) resolve(events.length);
        else if (Date.now() - started > 10000) reject(new Error("stream timeout: " + JSON.stringify(events)));
        else setTimeout(tick, 20);
      };
      tick();
    });
  const lineAt = (from, at) => events.slice(from).some((event) => event.kind === "line" && event.data.at === at);

  const created = await post("/api/cs/projects", { title: "Probe project" });
  const project = created.body.id;
  const listed = await get("/api/cs/projects");
  const operations = await get("/api/cs/operations");
  const stateBefore = await get("/api/cs/state?project=" + project);

  const source = new EventSource("/cs/events?project=" + project);
  for (const kind of ["ready", "record", "update", "line"]) {
    source.addEventListener(kind, (event) => events.push({ kind, data: JSON.parse(event.data) }));
  }
  try {
    const ready = await seen(() => events.some((event) => event.kind === "ready"));

    const run = await post("/api/cs/operation", {
      project,
      operation: ${JSON.stringify(OPERATION)},
      params: { text: "hello" },
      surface: "view",
    });
    const afterRun = await seen(() => lineAt(ready, run.body.id));
    const stateAfterRun = await get("/api/cs/state?project=" + project);

    const undo = await post("/api/cs/undo", { project });
    const afterUndo = await seen(() => lineAt(afterRun, undo.body.at));
    const stateAfterUndo = await get("/api/cs/state?project=" + project);

    const redo = await post("/api/cs/redo", { project });
    const afterRedo = await seen(() => lineAt(afterUndo, redo.body.at));

    const history = await post("/api/cs/history", { project });
    const summary = await get("/api/cs/projects/summary?project=" + project);
    return {
      created, listed, operations, stateBefore, run, stateAfterRun, undo, stateAfterUndo, redo,
      history, summary, events,
      marks: { ready, run: afterRun, undo: afterUndo, redo: afterRedo },
    };
  } finally {
    source.close();
  }
})()`;

/** A text field of a JSON answer; the test fails here when the answer lacks it. */
function textField(value: unknown, field: string): string {
  if (typeof value === "object" && value !== null) {
    const found: unknown = Reflect.get(value, field);
    if (typeof found === "string") return found;
  }
  throw new Error(`The answer has no text field "${field}": ${JSON.stringify(value)}`);
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A patch that adds the fixture component as one row. */
function componentPatch(): string {
  const dir = mkdtempSync(join(tempParent(), "cs-dsh-test-patch-"));
  dirs.push(dir);
  const patch = join(dir, "memo.patch.yml");
  writeFileSync(
    patch,
    JSON.stringify([{ insert: [{ id: "cs-test-memo", name: COMPONENT_PATH }] }]),
  );
  return patch;
}

describe("view API", () => {
  test("a page reads a project, runs an operation, and sees the change on the event stream", async () => {
    const dsh = await launchDsh({ patches: [componentPatch()] });
    try {
      const session = await openPage(dsh.url);
      try {
        const report = await session.page.evaluate<PageReport>(PAGE_SCRIPT);

        // A project made from a view: a fresh folder in the projects folder of the dsh process.
        expect(report.created.status).toBe(200);
        expect(report.created.body).toMatchObject({ title: "Probe project" });
        const project = report.created.body;
        expect(report.listed.body).toEqual([project]);
        const folder = textField(report.created.body, "path");
        expect(folder).toBe(join(dsh.home.userHome, "comfy-studio-projects", "Probe project"));
        expect(existsSync(join(folder, ".comfy-studio", "records.jsonl"))).toBe(true);

        // The fixture's operation is declared with its label; the state starts at the create step.
        expect(report.operations.body).toContainEqual(
          expect.objectContaining({ name: OPERATION, label: LABEL, resource: "none" }),
        );
        expect(report.stateBefore.status).toBe(200);
        expect(report.stateBefore.body).toMatchObject({
          project,
          assets: [],
          components: { [COMPONENT]: { texts: [] } },
        });

        // The run is a human record from a view, and the state read afterwards shows it.
        expect(report.run.status).toBe(200);
        expect(report.run.body).toMatchObject({
          operation: OPERATION,
          status: "done",
          actor: "user",
          surface: "view",
          params: { text: "hello" },
        });
        const runId = textField(report.run.body, "id");
        const createId = textField(report.stateBefore.body, "head");
        expect(report.stateAfterRun.body).toMatchObject({
          head: runId,
          tip: runId,
          components: { [COMPONENT]: { texts: ["hello"] } },
        });

        // The stream told the page about it: the record, its last update, and the new position.
        const duringRun = report.events.slice(report.marks.ready, report.marks.run);
        expect(duringRun).toContainEqual({
          kind: "record",
          data: expect.objectContaining({
            kind: "record",
            record: expect.objectContaining({ id: runId, operation: OPERATION }),
          }),
        });
        expect(duringRun).toContainEqual({
          kind: "line",
          data: { kind: "line", tip: runId, at: runId },
        });

        // Undo and redo move the position, write nothing, and each sends a `line` event.
        expect(report.undo.body).toEqual({ tip: runId, at: createId });
        expect(report.stateAfterUndo.body).toMatchObject({
          head: createId,
          tip: runId,
          components: { [COMPONENT]: { texts: [] } },
        });
        expect(report.redo.body).toEqual({ tip: runId, at: runId });
        const moves = report.events.slice(report.marks.run).map((event) => event.kind);
        expect(moves).toEqual(["line", "line"]);

        expect(report.history.body).toMatchObject({
          entries: [
            { place: "current", record: { id: runId } },
            { place: "before", record: { id: createId } },
          ],
          assets: [],
        });
        expect(report.summary.body).toEqual([
          { project: textField(project, "id"), cover: null, edited_at: expect.any(String) },
        ]);

        expect(session.issues).toEqual([]);
      } finally {
        await session.close();
      }
    } finally {
      await dsh.stop();
    }
  });

  test("a request without the login cookie reaches neither the routes nor the stream", async () => {
    const dsh = await launchDsh();
    try {
      // The origin alone: the login URL's token must not travel with these requests.
      const origin = new URL(dsh.url).origin;
      const routes = await fetch(`${origin}/api/cs/projects`);
      expect(routes.status).toBe(401);
      const stream = await fetch(`${origin}/cs/events?project=anything`);
      expect(stream.status).toBe(401);
      expect(stream.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    } finally {
      await dsh.stop();
    }
  });
});
