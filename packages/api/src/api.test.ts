import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ProjectError, type ProjectEvent, type ProjectId, type ProjectRecord } from "@cs/project";
import { agentOrigin, asError, defined, standIn } from "@cs/project/testing/support";
import { answer, ApiRequestError } from "./api.ts";
import { asRecord, mountApi, ROUTES, type ApiFixture } from "./testing/support.ts";

/**
 * @param fixture - the mounted API.
 * @param project - the project.
 * @returns every record of the project's history list, newest first.
 */
async function historyOf(fixture: ApiFixture, project: ProjectId): Promise<ProjectRecord[]> {
  const history = await fixture.api.listHistory({ project, limit: 200 });
  return history.entries.map((entry) => entry.record);
}

/**
 * Run `probe_note.add` through the route.
 * @param fixture - the mounted API.
 * @param project - the project.
 * @param text - the note.
 * @param extra - more request fields.
 * @returns the record.
 */
async function addNote(
  fixture: ApiFixture,
  project: ProjectId,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<ProjectRecord> {
  return fixture.api.runOperation({
    project,
    operation: "probe_note.add",
    params: { text },
    ...extra,
  });
}

/**
 * @param fixture - the mounted API.
 * @param project - the project.
 * @returns the notes of the project's current state.
 */
function notesOf(fixture: ApiFixture, project: ProjectId): unknown {
  const slice = asRecord(asRecord(fixture.api.getState(project).components)["probe_note"]);
  return slice["notes"];
}

describe("answer", () => {
  it("answers an ApiRequestError with its status, code and details", async () => {
    const response = await answer(() => {
      throw new ApiRequestError(404, "nope", "unknown_project", { extra: 1 });
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "nope", code: "unknown_project", extra: 1 });
  });

  it("answers a ProjectError with the status of its code, else 409", async () => {
    const unknown = await answer(() => {
      throw new ProjectError("unknown_record", "no record");
    });
    expect(unknown.status).toBe(404);
    const other = await answer(() => {
      throw new ProjectError("nothing_to_undo", "nothing");
    });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "nothing", code: "nothing_to_undo" });
  });

  it("answers any other throw with 500 internal_error", async () => {
    const response = await answer(() => {
      throw new Error("boom");
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "boom", code: "internal_error" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("routes", () => {
  it("registers every path of ROUTES once", async () => {
    const f = await mountApi();
    expect(f.routes.map((route) => route.path).toSorted()).toEqual(
      Object.values(ROUTES).toSorted(),
    );
    for (const route of f.routes) expect(route.requestBody).toBe("buffered");
  });

  it("answers a body that is not JSON as a missing field", async () => {
    const f = await mountApi();
    const result = await f.call(ROUTES.operation, { method: "POST", body: "not json" });
    expect(result.status).toBe(400);
    expect(asRecord(result.json)["code"]).toBe("invalid_params");
  });

  it("serves projects and state through real Fetch requests", async () => {
    const f = await mountApi();
    const created = await f.call(ROUTES.projects, { json: { title: "Via route" } });
    expect(created.status).toBe(200);
    const id = String(asRecord(created.json)["id"]);
    const listed = await f.call(ROUTES.projects);
    expect(listed.status).toBe(200);
    expect(standIn<Array<{ id: string }>>(listed.json).map((p) => p.id)).toEqual([id]);
    const state = await f.call(ROUTES.state, { query: { project: id } });
    expect(state.status).toBe(200);
    expect(asRecord(asRecord(state.json)["project"])["title"]).toBe("Via route");
  });
});

describe("project list and state", () => {
  it("lists projects newest first with id, title, created_at and path", async () => {
    const f = await mountApi();
    const a = await f.newProject("Alpha");
    const b = await f.newProject("Beta");
    const c = await f.newProject("Gamma");
    const list = f.api.listProjects();
    expect(list.map((p) => p.id)).toEqual([c, b, a]);
    expect(list.map((p) => p.title)).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(Object.keys(list[0] ?? {}).toSorted()).toEqual(["created_at", "id", "path", "title"]);
    expect(list[0]?.path).toContain("Gamma");
  });

  it("reads the state: head equals tip on a fresh project, with the component slices and no assets", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const state = f.api.getState(project);
    expect(state.head).toBe(state.tip);
    expect(state.project.id).toBe(project);
    expect(Object.keys(state.components)).toEqual(expect.arrayContaining(["proj", "probe_note"]));
    expect(notesOf(f, project)).toEqual([]);
    expect(state.assets).toEqual([]);
  });

  it("lists the assets the state mentions with made_by and the store's url", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const snap = await f.api.runOperation({ project, operation: "probe_note.snap" });
    const output = defined(snap.outputs[0], "the snap output");
    const { assets } = f.api.getState(project);
    expect(assets).toEqual([
      {
        id: output,
        mime: "image/png",
        name: "snap-1.png",
        url: `https://assets.example/${output}`,
        made_by: "probe_note.snap",
      },
    ]);
  });

  it("moves head back on undo and keeps the tip", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    await addNote(f, project, "one");
    const before = f.api.getState(project);
    await f.api.undo({ project });
    const after = f.api.getState(project);
    expect(after.head).not.toBe(before.head);
    expect(after.tip).toBe(before.tip);
  });

  it("answers 400 invalid_params for a missing or malformed project and 404 for an unknown one", async () => {
    const f = await mountApi();
    const queries: Array<Record<string, string>> = [{}, { project: "bad id!" }];
    for (const query of queries) {
      const result = await f.call(ROUTES.state, { query });
      expect(result.status).toBe(400);
      expect(asRecord(result.json)["code"]).toBe("invalid_params");
    }
    const unknown = await f.call(ROUTES.state, { query: { project: "nothing" } });
    expect(unknown.status).toBe(404);
    expect(asRecord(unknown.json)["code"]).toBe("unknown_project");
  });
});

describe("operation declarations", () => {
  it("lists the declarations without readOnly operations, with a label only when declared", async () => {
    const f = await mountApi();
    const result = await f.call(ROUTES.operations);
    expect(result.status).toBe(200);
    const operations = standIn<Array<Record<string, unknown>>>(result.json);
    const names = operations.map((operation) => operation["name"]);
    expect(names).toEqual(
      expect.arrayContaining([
        "probe_note.add",
        "probe_note.snap",
        "probe_note.slow",
        "probe_note.use",
      ]),
    );
    expect(names).not.toContain("probe_note.peek");
    const byName = new Map(operations.map((operation) => [operation["name"], operation]));
    expect(byName.get("probe_note.snap")?.["label"]).toBe("Snap");
    expect(byName.get("probe_note.add")).not.toHaveProperty("label");
    const add = defined(byName.get("probe_note.add"));
    expect(add["params"]).toEqual({
      text: { type: "string", required: true, description: "The note." },
    });
    expect(add).not.toHaveProperty("execute");
    expect(add["resource"]).toBe("none");
  });
});

describe("running operations", () => {
  it("records a run as the user with surface view by default and the request's session", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const record = await addNote(f, project, "hello", { session: "s1" });
    expect(record).toMatchObject({
      actor: "user",
      surface: "view",
      session: "s1",
      turn: null,
      tool_call: null,
      operation: "probe_note.add",
      status: "done",
      intent: "view: probe_note.add",
    });
    expect(notesOf(f, project)).toEqual(["hello"]);
  });

  it("keeps surface chat and counts any other surface as view", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const chat = await addNote(f, project, "a", { surface: "chat" });
    expect(chat.surface).toBe("chat");
    expect(chat.intent).toBe("chat: probe_note.add");
    for (const surface of ["api", "history", "whatever", 7, null]) {
      const record = await addNote(f, project, "b", { surface });
      expect(record.surface).toBe("view");
    }
    const withoutSession = await addNote(f, project, "c", { session: "" });
    expect(withoutSession.session).toBeNull();
  });

  it("uses the request's intent when it names one", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const record = await addNote(f, project, "x", { intent: "add a note by hand" });
    expect(record.intent).toBe("add a note by hand");
  });

  it("records based_on and supersedes, ignoring non-string supersedes entries", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const first = await f.api.runOperation({ project, operation: "probe_note.snap" });
    const second = await f.api.runOperation({
      project,
      operation: "probe_note.snap",
      based_on: first.id,
      supersedes: [first.id, 5, null],
    });
    expect(second.based_on).toBe(first.id);
    expect(second.supersedes).toEqual([first.id]);
  });

  it("answers 400 invalid_params for a body that lacks the operation or has bad params", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const cases: Array<Record<string, unknown>> = [
      { project },
      { project, operation: "" },
      { project, operation: "probe_note.add" },
      { project, operation: "probe_note.add", params: { text: 5 } },
      { project, operation: "probe_note.add", params: { text: "x" }, inputs: "no" },
      { project, operation: "probe_note.add", params: { text: "x" }, inputs: [{ role: "a" }] },
      { project, operation: "probe_note.add", params: { text: "x" }, inputs: [{ ref: "a" }] },
    ];
    for (const json of cases) {
      const result = await f.call(ROUTES.operation, { json });
      expect(result.status, JSON.stringify(json)).toBe(400);
      expect(asRecord(result.json)["code"]).toBe("invalid_params");
      expect(typeof asRecord(result.json)["error"]).toBe("string");
    }
    expect(await historyOf(f, project)).toHaveLength(1);
  });

  it("answers 404 for an unknown operation, project or input record, and 400 invalid_inputs for an unknown role", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const unknownOperation = await f.call(ROUTES.operation, {
      json: { project, operation: "probe_note.nope" },
    });
    expect(unknownOperation.status).toBe(404);
    expect(asRecord(unknownOperation.json)["code"]).toBe("unknown_operation");
    const unknownProject = await f.call(ROUTES.operation, {
      json: { project: "nothing", operation: "probe_note.snap" },
    });
    expect(unknownProject.status).toBe(404);
    expect(asRecord(unknownProject.json)["code"]).toBe("unknown_project");
    const badRole = await f.call(ROUTES.operation, {
      json: {
        project,
        operation: "probe_note.use",
        inputs: [{ role: "nope", ref: "x" }],
      },
    });
    expect(badRole.status).toBe(400);
    expect(asRecord(badRole.json)["code"]).toBe("invalid_inputs");
    const missingAsset = await f.call(ROUTES.operation, {
      json: {
        project,
        operation: "probe_note.use",
        inputs: [{ role: "source", ref: "f".repeat(64) }],
      },
    });
    expect(missingAsset.status).toBe(404);
    expect(asRecord(missingAsset.json)["code"]).toBe("unknown_asset");
  });

  it("does not list a readOnly operation, and refuses to run it without executing it", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    expect(f.api.listOperations().map((o) => o.name)).not.toContain("probe_note.peek");
    const json = { project, operation: "probe_note.peek" };
    const result = await f.call(ROUTES.operation, { json });
    expect(result.status).toBe(400);
    expect(asRecord(result.json)["code"]).toBe("read_only_operation");
    // The check gives the same sentence as a problem, as for every refusal of the run.
    const check = await f.call(ROUTES.operationCheck, { json });
    expect(check.status).toBe(200);
    expect(check.json).toEqual({ problems: [asRecord(result.json)["error"]] });
    expect(f.reads()).toBe(0);
    expect(await historyOf(f, project)).toHaveLength(1);
  });

  it("answers 400 invalid_inputs for a role named like an Object.prototype member", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    for (const role of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const json = { project, operation: "probe_note.use", inputs: [{ role, ref: "x" }] };
      const run = await f.call(ROUTES.operation, { json });
      expect(run.status, role).toBe(400);
      expect(asRecord(run.json)["code"], role).toBe("invalid_inputs");
      const check = await f.call(ROUTES.operationCheck, { json });
      expect(check.json, role).toEqual({ problems: [asRecord(run.json)["error"]] });
    }
    expect(await historyOf(f, project)).toHaveLength(1);
  });

  it("schedules a call whose input names an unfinished record and finishes it after the producer", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const release = f.holdSlow();
    const events: ProjectEvent[] = [];
    f.project.subscribe(project, (event) => events.push(event));
    const producerRun = f.api.runOperation({ project, operation: "probe_note.slow" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "record")).toBe(true);
    });
    const producerId = defined(
      events.flatMap((event) => (event.kind === "record" ? [event.record.id] : []))[0],
      "the producer record",
    );
    const consumer = await f.api.runOperation({
      project,
      operation: "probe_note.use",
      inputs: [{ role: "source", ref: `${producerId}#0` }],
    });
    expect(consumer.status).toBe("pending");
    expect(f.project.getRecord(project, producerId).status).not.toBe("done");
    release();
    const producer = await producerRun;
    expect(producer.status).toBe("done");
    await vi.waitFor(() => {
      expect(f.project.getRecord(project, consumer.id).status).toBe("done");
    });
    const finished = f.project.getRecord(project, consumer.id);
    expect(finished.inputs[0]?.resolved_asset).toBe(producer.outputs[0]);
    expect(f.project.getRecord(project, producerId).finished_at).toBeDefined();
  });

  it("runs a call at once when its input record is finished", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const producer = await f.api.runOperation({ project, operation: "probe_note.snap" });
    const consumer = await f.api.runOperation({
      project,
      operation: "probe_note.use",
      inputs: [{ role: "source", ref: `${producer.id}#0` }],
    });
    expect(consumer.status).toBe("done");
  });
});

describe("checking operations", () => {
  it("writes nothing and gives the sentence the run refuses with", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const before = await historyOf(f, project);
    const bad = { project, operation: "probe_note.add", params: {} };
    const check = await f.call(ROUTES.operationCheck, { json: bad });
    expect(check.status).toBe(200);
    const problems = standIn<string[]>(asRecord(check.json)["problems"]);
    expect(problems).toHaveLength(1);
    const run = await f.call(ROUTES.operation, { json: bad });
    expect(run.status).toBe(400);
    expect(asRecord(run.json)["error"]).toBe(problems[0]);
    expect(await historyOf(f, project)).toEqual(before);

    const ok = await f.api.checkOperation({
      project,
      operation: "probe_note.add",
      params: { text: "x" },
    });
    expect(ok).toEqual({ problems: [] });
    expect(await historyOf(f, project)).toEqual(before);
  });

  it("turns an unknown operation and unparsable input into problems", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const unknown = await f.api.checkOperation({ project, operation: "probe_note.nope" });
    expect(unknown.problems).toEqual(["Unknown operation 'probe_note.nope'."]);
    const role = { project, operation: "probe_note.use", inputs: [{ role: "nope", ref: "x" }] };
    const badRole = await f.api.checkOperation(role);
    expect(badRole.problems).toHaveLength(1);
    const run = await f.call(ROUTES.operation, { json: role });
    expect(asRecord(run.json)["error"]).toBe(badRole.problems[0]);
  });

  it("still answers an error for an unknown project or a malformed body", async () => {
    const f = await mountApi();
    const unknown = await f.call(ROUTES.operationCheck, {
      json: { project: "nothing", operation: "probe_note.snap" },
    });
    expect(unknown.status).toBe(404);
    const malformed = await f.call(ROUTES.operationCheck, {
      json: { operation: "probe_note.snap" },
    });
    expect(malformed.status).toBe(400);
  });

  it("accepts a call that names an unfinished record", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const release = f.holdSlow();
    const events: ProjectEvent[] = [];
    f.project.subscribe(project, (event) => events.push(event));
    const producerRun = f.api.runOperation({ project, operation: "probe_note.slow" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "record")).toBe(true);
    });
    const id = defined(
      events.flatMap((event) => (event.kind === "record" ? [event.record.id] : []))[0],
    );
    const check = await f.api.checkOperation({
      project,
      operation: "probe_note.use",
      inputs: [{ role: "source", ref: `${id}#0` }],
    });
    expect(check.problems).toEqual([]);
    release();
    await producerRun;
  });
});

describe("undo and redo", () => {
  it("answers 409 nothing_to_undo and nothing_to_redo on a fresh project", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const undo = await f.call(ROUTES.undo, { json: { project } });
    expect(undo.status).toBe(409);
    expect(asRecord(undo.json)["code"]).toBe("nothing_to_undo");
    const redo = await f.call(ROUTES.redo, { json: { project } });
    expect(redo.status).toBe(409);
    expect(asRecord(redo.json)["code"]).toBe("nothing_to_redo");
  });

  it("undoes one step and redoes it", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    await addNote(f, project, "one");
    const second = await addNote(f, project, "two");
    const undone = await f.call(ROUTES.undo, { json: { project } });
    expect(undone.status).toBe(200);
    expect(asRecord(undone.json)["tip"]).toBe(second.id);
    expect(asRecord(undone.json)["at"]).not.toBe(second.id);
    expect(notesOf(f, project)).toEqual(["one"]);
    const redone = await f.call(ROUTES.redo, { json: { project } });
    expect(asRecord(redone.json)).toEqual({ tip: second.id, at: second.id });
    expect(notesOf(f, project)).toEqual(["one", "two"]);
    const again = await f.call(ROUTES.redo, { json: { project } });
    expect(again.status).toBe(409);
  });

  it("undoes to a named step and redo then moves forward one step", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const one = await addNote(f, project, "one");
    await addNote(f, project, "two");
    await addNote(f, project, "three");
    const line = await f.api.undo({ project, to: one.id });
    expect(line.at).toBe(one.id);
    expect(notesOf(f, project)).toEqual(["one"]);
    await f.api.redo({ project });
    expect(notesOf(f, project)).toEqual(["one", "two"]);
  });

  it("answers an unknown or malformed `to` with an error", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    await addNote(f, project, "one");
    const unknown = await f.call(ROUTES.undo, { json: { project, to: "no-such-record" } });
    expect(unknown.status).toBe(404);
    expect(asRecord(unknown.json)["code"]).toBe("unknown_record");
    const malformed = await f.call(ROUTES.undo, { json: { project, to: "" } });
    expect(malformed.status).toBe(400);
    expect(asRecord(malformed.json)["code"]).toBe("invalid_params");
    const wrongType = await f.call(ROUTES.undo, { json: { project, to: 5 } });
    expect(wrongType.status).toBe(400);
  });

  it("discards the steps after the current position when a write follows an undo", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    await addNote(f, project, "one");
    const two = await addNote(f, project, "two");
    await f.api.undo({ project });
    const three = await addNote(f, project, "three");
    expect(notesOf(f, project)).toEqual(["one", "three"]);
    const state = f.api.getState(project);
    expect(state.head).toBe(three.id);
    expect(state.tip).toBe(three.id);
    const ids = (await historyOf(f, project)).map((record) => record.id);
    expect(ids).toContain(three.id);
    expect(ids).not.toContain(two.id);
    const redo = await f.call(ROUTES.redo, { json: { project } });
    expect(redo.status).toBe(409);
  });

  it("answers 404 for an unknown project and 400 for a missing one", async () => {
    const f = await mountApi();
    expect((await f.call(ROUTES.undo, { json: { project: "nothing" } })).status).toBe(404);
    expect((await f.call(ROUTES.redo, { json: {} })).status).toBe(400);
  });
});

describe("history", () => {
  it("lists the whole list newest first with the assets the entries name", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    await addNote(f, project, "one");
    const snap = await f.api.runOperation({ project, operation: "probe_note.snap" });
    const history = await f.api.listHistory({ project });
    expect(history.entries.map((entry) => entry.record.operation)).toEqual([
      "probe_note.snap",
      "probe_note.add",
      "proj.create",
    ]);
    expect(history.entries.map((entry) => entry.place)).toEqual(["current", "before", "before"]);
    expect(history.assets.map((asset) => asset.id)).toEqual(snap.outputs);
    expect(history.assets[0]?.url).toBe(`https://assets.example/${String(snap.outputs[0])}`);
  });

  it("names the assets of a resolved input as well", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const snap = await f.api.runOperation({ project, operation: "probe_note.snap" });
    await f.api.runOperation({
      project,
      operation: "probe_note.use",
      inputs: [{ role: "source", ref: `${snap.id}#0` }],
    });
    const only = await f.api.listHistory({ project, operation: "probe_note.use" });
    expect(only.entries).toHaveLength(1);
    expect(only.assets.map((asset) => asset.id)).toEqual(snap.outputs);
  });

  it("filters by actor, component, operation, kind, status, session, turn, tool_call and records", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const user = await addNote(f, project, "by user", { session: "s1" });
    const agent = defined(
      (
        await f.project.run({
          ...agentOrigin("turn-9"),
          project,
          operation: "probe_note.add",
          params: { text: "by agent" },
          inputs: [],
        })
      ).record,
    );
    const snap = await f.api.runOperation({ project, operation: "probe_note.snap" });
    const idsOf = async (query: Record<string, unknown>): Promise<string[]> =>
      (await f.api.listHistory({ project, ...query })).entries.map((entry) => entry.record.id);

    expect(await idsOf({ actor: "agent" })).toEqual([agent.id]);
    expect(await idsOf({ actor: "user", operation: "probe_note.add" })).toEqual([user.id]);
    expect(await idsOf({ actor: "system" })).toEqual([]);
    expect(await idsOf({ component: "probe_note" })).toEqual([snap.id, agent.id, user.id]);
    expect(await idsOf({ operation: "probe_note.snap" })).toEqual([snap.id]);
    expect(await idsOf({ kind: "operation", component: "proj" })).toHaveLength(1);
    expect(await idsOf({ status: "done", component: "probe_note" })).toHaveLength(3);
    expect(await idsOf({ status: "failed" })).toEqual([]);
    expect(await idsOf({ session: "s1", component: "probe_note" })).toEqual([user.id]);
    expect(await idsOf({ session: "session-a" })).toEqual([agent.id]);
    expect(await idsOf({ turn: "turn-9" })).toEqual([agent.id]);
    expect(await idsOf({ tool_call: "call-turn-9" })).toEqual([agent.id]);
    expect(await idsOf({ records: [user.id, snap.id] })).toEqual([snap.id, user.id]);
    // null counts as "not given"
    expect(await idsOf({ actor: null, limit: null, records: null })).toHaveLength(4);
  });

  it("pages with before and limit", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    for (const text of ["a", "b", "c", "d"]) await addNote(f, project, text);
    const all = (await f.api.listHistory({ project })).entries.map((entry) => entry.record.id);
    expect(all).toHaveLength(5);
    const first = await f.api.listHistory({ project, limit: 2 });
    expect(first.entries.map((entry) => entry.record.id)).toEqual(all.slice(0, 2));
    const second = await f.api.listHistory({ project, limit: 2, before: all[1] });
    expect(second.entries.map((entry) => entry.record.id)).toEqual(all.slice(2, 4));
    const last = await f.api.listHistory({ project, limit: 2, before: all[3] });
    expect(last.entries.map((entry) => entry.record.id)).toEqual(all.slice(4));
    const capped = await f.api.listHistory({ project, limit: 200 });
    expect(capped.entries).toHaveLength(5);
  });

  it("marks the steps a redo brings back as after", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    await addNote(f, project, "one");
    await f.api.undo({ project });
    const { entries } = await f.api.listHistory({ project });
    expect(entries.map((entry) => entry.place)).toEqual(["after", "current"]);
  });

  it("answers 400 invalid_params for filters of the wrong type or an unknown enum value", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const bad: Array<Record<string, unknown>> = [
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { limit: "5" },
      { limit: -1 },
      { actor: "bot" },
      { actor: 5 },
      { kind: "request" },
      { status: "stuck" },
      { component: 5 },
      { operation: "" },
      { session: {} },
      { before: 7 },
      { records: "abc" },
      { records: [1] },
    ];
    for (const extra of bad) {
      const result = await f.call(ROUTES.history, { json: { project, ...extra } });
      expect(result.status, JSON.stringify(extra)).toBe(400);
      expect(asRecord(result.json)["code"]).toBe("invalid_params");
    }
  });

  it("answers 404 for an unknown `before` record and an unknown project, 400 for a missing project", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const before = await f.call(ROUTES.history, { json: { project, before: "no-such-record" } });
    expect(before.status).toBe(404);
    expect(asRecord(before.json)["code"]).toBe("unknown_record");
    expect((await f.call(ROUTES.history, { json: { project: "nothing" } })).status).toBe(404);
    expect((await f.call(ROUTES.history, { json: {} })).status).toBe(400);
  });
});

describe("stale accept", () => {
  it("removes the stale mark of a record made from a superseded one and records who accepted", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const producer = await f.api.runOperation({ project, operation: "probe_note.snap" });
    const consumer = await f.api.runOperation({
      project,
      operation: "probe_note.use",
      inputs: [{ role: "source", ref: `${producer.id}#0` }],
    });
    await f.api.runOperation({
      project,
      operation: "probe_note.snap",
      supersedes: [producer.id],
    });
    const stale = (): Record<string, unknown> =>
      asRecord(f.project.getState(project).components.proj.stale);
    expect(Object.keys(stale())).toContain(consumer.id);
    const result = await f.call(ROUTES.acceptStale, {
      json: { project, record: consumer.id, session: "s1", surface: "chat" },
    });
    expect(result.status).toBe(200);
    expect(asRecord(result.json)).toMatchObject({
      operation: "proj.stale_accept",
      actor: "user",
      surface: "chat",
      session: "s1",
      params: { record: consumer.id },
    });
    expect(Object.keys(stale())).not.toContain(consumer.id);
  });

  it("answers 404 unknown_record for a record that does not exist and 400 for a missing one", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const unknown = await f.call(ROUTES.acceptStale, {
      json: { project, record: "no-such-record" },
    });
    expect(unknown.status).toBe(404);
    expect(asRecord(unknown.json)["code"]).toBe("unknown_record");
    const missing = await f.call(ROUTES.acceptStale, { json: { project } });
    expect(missing.status).toBe(400);
    expect(asRecord(missing.json)["code"]).toBe("invalid_params");
    expect(
      (await f.call(ROUTES.acceptStale, { json: { project: "nothing", record: "x" } })).status,
    ).toBe(404);
  });
});

describe("project management", () => {
  it("creates a project by title in the projects folder, a user record with surface view", async () => {
    const f = await mountApi();
    const info = await f.api.createProject({ title: "Moodboard" });
    expect(info.title).toBe("Moodboard");
    expect(info.path.startsWith(`${f.root}/projects/`)).toBe(true);
    expect(existsSync(info.path)).toBe(true);
    const [create] = await historyOf(f, info.id);
    expect(create).toMatchObject({
      operation: "proj.create",
      actor: "user",
      surface: "view",
      session: null,
      params: { title: "Moodboard" },
    });
  });

  it("numbers a title another project already has", async () => {
    const f = await mountApi();
    const titles: string[] = [];
    for (const wanted of ["Same", "Same", "Same", "Same 2", "Other 7", "Other 7"]) {
      titles.push((await f.api.createProject({ title: wanted })).title);
    }
    expect(titles).toEqual(["Same", "Same 2", "Same 3", "Same 4", "Other 7", "Other 8"]);
    const paths = new Set(f.api.listProjects().map((project) => project.path));
    expect(paths.size).toBe(6);
  });

  it("gives creates that overlap distinct titles, and a failed create does not hold up the next", async () => {
    const f = await mountApi();
    const created = await Promise.all([
      f.api.createProject({ title: "Dup" }),
      f.api.createProject({ title: "Dup" }),
      f.api.createProject({ title: "Dup" }),
    ]);
    expect(created.map((info) => info.title).toSorted()).toEqual(["Dup", "Dup 2", "Dup 3"]);
    expect(new Set(created.map((info) => info.path)).size).toBe(3);
    await expect(f.api.createProject({})).rejects.toThrow(ApiRequestError);
    expect((await f.api.createProject({ title: "Dup" })).title).toBe("Dup 4");
  });

  it("answers 400 invalid_params for names a folder cannot carry and for a folder that does not exist", async () => {
    const f = await mountApi();
    const project = await f.newProject("Kept");
    const refusals: Array<[string, unknown]> = [
      [ROUTES.projects, { title: "a\u0000b" }],
      [ROUTES.projects, { title: "a\nb" }],
      [ROUTES.projects, { title: "x".repeat(201) }],
      // 67 three-byte characters are 201 bytes.
      [ROUTES.projects, { title: "가".repeat(67) }],
      [ROUTES.projects, { folder: "/definitely/not/here" }],
      [ROUTES.projects, { folder: "/" }],
      [ROUTES.untitled, { name: "a\u0000b" }],
      [ROUTES.untitled, { name: "x".repeat(201) }],
      [ROUTES.projectRename, { project, title: "a\u0007b" }],
      [ROUTES.projectRename, { project, title: "x".repeat(201) }],
    ];
    for (const [path, json] of refusals) {
      const result = await f.call(path, { json });
      expect(result.status, JSON.stringify(json).slice(0, 60)).toBe(400);
      expect(asRecord(result.json)["code"]).toBe("invalid_params");
      // The message names the field, never a path on the host.
      expect(String(asRecord(result.json)["error"])).not.toContain(f.root);
    }
    expect(f.api.listProjects().map((info) => info.title)).toEqual(["Kept"]);
    // The limit is in bytes, so the longest name that fits still works.
    expect((await f.api.createProject({ title: "가".repeat(66) })).title).toBe("가".repeat(66));
  });

  it("makes a chat's folder a project with surface chat and the session, titled after the folder", async () => {
    const f = await mountApi();
    const folder = await f.project.newProjectFolder("From chat");
    f.services.chats.open("chat-1", folder);
    const info = await f.api.createProject({ folder, session: "chat-1", surface: "view" });
    expect(info.title).toBe("From chat");
    const [create] = await historyOf(f, info.id);
    expect(create).toMatchObject({ operation: "proj.create", surface: "chat", session: "chat-1" });
    expect(f.services.workspaces.list()[0]?.sessionIds).toContain("chat-1");
  });

  it("keeps the title and records of a folder that is a project already", async () => {
    const f = await mountApi();
    const folder = await f.project.newProjectFolder("Kept");
    const first = await f.api.createProject({ folder });
    await f.api.renameProject({ project: first.id, title: "Renamed" });
    const again = await f.api.createProject({ folder });
    expect(again.id).toBe(first.id);
    expect(again.title).toBe("Renamed");
    expect(f.api.listProjects()).toHaveLength(1);
    expect(await historyOf(f, first.id)).toHaveLength(1);
  });

  it("answers 400 invalid_params for a missing title, folder of the wrong type, or a blank name", async () => {
    const f = await mountApi();
    for (const json of [{}, { title: "" }, { title: 5 }, { folder: "" }, { folder: 5 }]) {
      const result = await f.call(ROUTES.projects, { json });
      expect(result.status, JSON.stringify(json)).toBe(400);
      expect(asRecord(result.json)["code"]).toBe("invalid_params");
    }
    expect(f.api.listProjects()).toEqual([]);
  });

  it("makes an untitled folder, numbered when the name is taken", async () => {
    const f = await mountApi();
    const first = await f.call(ROUTES.untitled, { json: { name: "Untitled project" } });
    const second = await f.call(ROUTES.untitled, { json: { name: "Untitled project" } });
    expect(first.status).toBe(200);
    const paths = [first, second].map((result) => String(asRecord(result.json)["path"]));
    expect(paths[0]).toBe(`${f.root}/projects/Untitled project`);
    expect(paths[1]).toBe(`${f.root}/projects/Untitled project 2`);
    for (const path of paths) expect(existsSync(path)).toBe(true);
    expect(f.api.listProjects()).toEqual([]);
    const missing = await f.call(ROUTES.untitled, { json: {} });
    expect(missing.status).toBe(400);
    expect(asRecord(missing.json)["code"]).toBe("invalid_params");
  });

  it("renames a project to a unique title", async () => {
    const f = await mountApi();
    const a = await f.newProject("Alpha");
    const b = await f.newProject("Beta");
    const renamed = await f.call(ROUTES.projectRename, { json: { project: a, title: "Gamma" } });
    expect(renamed.json).toEqual({ title: "Gamma" });
    const clash = await f.call(ROUTES.projectRename, { json: { project: b, title: "Gamma" } });
    expect(clash.json).toEqual({ title: "Gamma 2" });
    expect(f.api.listProjects().map((project) => project.title)).toEqual(["Gamma 2", "Gamma"]);
    const trimmed = await f.api.renameProject({ project: a, title: "  Padded  " });
    expect(trimmed.title).toBe("Padded");
  });

  it("answers 400 for a blank or missing title and 404 for an unknown project on rename", async () => {
    const f = await mountApi();
    const project = await f.newProject("Alpha");
    for (const json of [
      { project, title: "   " },
      { project, title: "" },
      { project },
      { project, title: 5 },
    ]) {
      const result = await f.call(ROUTES.projectRename, { json });
      expect(result.status, JSON.stringify(json)).toBe(400);
      expect(asRecord(result.json)["code"]).toBe("invalid_params");
    }
    expect(
      (await f.call(ROUTES.projectRename, { json: { project: "nothing", title: "X" } })).status,
    ).toBe(404);
    expect((await f.call(ROUTES.projectRename, { json: { title: "X" } })).status).toBe(400);
    expect(f.api.listProjects()[0]?.title).toBe("Alpha");
  });

  it("removes a project from the list and leaves its folder; later requests answer 404", async () => {
    const f = await mountApi();
    const keep = await f.newProject("Keep");
    const gone = await f.newProject("Gone");
    const path = defined(f.api.listProjects().find((p) => p.id === gone)).path;
    const result = await f.call(ROUTES.projectDelete, { json: { project: gone } });
    expect(result).toEqual({ status: 200, json: { ok: true } });
    expect(f.api.listProjects().map((project) => project.id)).toEqual([keep]);
    expect(existsSync(path)).toBe(true);
    for (const attempt of [
      f.call(ROUTES.state, { query: { project: gone } }),
      f.call(ROUTES.operation, { json: { project: gone, operation: "probe_note.snap" } }),
      f.call(ROUTES.history, { json: { project: gone } }),
      f.call(ROUTES.projectDelete, { json: { project: gone } }),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(404);
      expect(asRecord(response.json)["code"]).toBe("unknown_project");
    }
    expect((await f.call(ROUTES.projectDelete, { json: {} })).status).toBe(400);
  });

  it("restores a removed project when its folder is made a project again", async () => {
    const f = await mountApi();
    const project = await f.newProject("Back");
    await addNote(f, project, "kept");
    const { path } = defined(f.api.listProjects()[0]);
    await f.api.removeProject({ project });
    const restored = await f.api.createProject({ folder: path });
    expect(restored.path).toBe(path);
    expect(notesOf(f, restored.id)).toEqual(["kept"]);
  });
});

describe("handler errors", () => {
  it("throws ApiRequestError from the handlers themselves", async () => {
    const f = await mountApi();
    expect(() => f.api.getState("bad id!")).toThrow(ApiRequestError);
    try {
      f.api.getState("nothing");
      expect.unreachable();
    } catch (error) {
      expect(asError(error, ApiRequestError)).toMatchObject({
        status: 404,
        code: "unknown_project",
      });
    }
  });
});

describe("answer and internal errors", () => {
  it("reports a failure answered with 500, and no refusal", async () => {
    const reported: unknown[] = [];
    const report = (error: unknown): void => {
      reported.push(error);
    };
    const boom = new Error("boom");
    const failed = await answer(() => {
      throw boom;
    }, report);
    expect(failed.status).toBe(500);
    expect(reported).toEqual([boom]);
    const refused = await answer(() => {
      throw new ApiRequestError(400, "no", "invalid_params");
    }, report);
    expect(refused.status).toBe(400);
    const projectRefusal = await answer(() => {
      throw new ProjectError("nothing_to_undo", "no");
    }, report);
    expect(projectRefusal.status).toBe(409);
    expect(reported).toHaveLength(1);
  });
});

describe("the asset reader of the project layer", () => {
  it("offers reads only and follows the registered store", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const reader = f.project.assets();
    expect(Object.keys(reader).toSorted()).toEqual(["get", "has", "url"]);
    const snap = await f.api.runOperation({ project, operation: "probe_note.snap" });
    const asset = defined(snap.outputs[0], "the output");
    // The reader was made before the asset existed.
    expect(reader.has(asset)).toBe(true);
    expect(reader.get(asset)).toMatchObject({ mime: "image/png" });
    expect(reader.url(asset)).toBe(f.assets.url(asset));
  });
});
