/**
 * Record store tests: the record format on disk, the append rule (a record follows the current position and becomes the
 * last step and the current position, kept in `line.json`), moves of the current position, the update rules, the
 * current form of records, reading a project on first use, the project lock, forgetting a removed project, and change
 * events. The record store calls only its project lookup, so these tests build it alone over test project folders.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it } from "vitest";
import { RecordStore, type RecordLineInput } from "./record-store.ts";
import { ProjectError } from "./shared.ts";
import type { AssetId, ProjectEvent, ProjectId, ProjectRecord, RecordId } from "./types.ts";
import { readLines, tempRoot, TestFolders, userOrigin } from "./testing/support.ts";

/** A record store over test project folders on a temporary root, and the events it emitted. */
interface OpenStore {
  root: string;
  folders: TestFolders;
  store: RecordStore;
  events: Array<{ project: ProjectId; event: ProjectEvent }>;
}

/**
 * Build a record store, as a new process does.
 * @param folders - the project folders; fresh ones on a temporary root by default.
 * @returns the store and its event list.
 */
function openStore(folders = new TestFolders(tempRoot())): OpenStore {
  const events: OpenStore["events"] = [];
  const store = new RecordStore(folders, (project, event) => {
    events.push({ project, event });
  });
  return { root: folders.root, folders, store, events };
}

/**
 * A record line for an operation of the `batch` component.
 * @param parent - the project's current position, or null for the first record.
 * @param overrides - fields to change.
 * @returns the line.
 */
function line(parent: RecordId | null, overrides: Partial<RecordLineInput> = {}): RecordLineInput {
  return {
    parents: parent === null ? [] : [parent],
    kind: "operation",
    component: "batch",
    operation: "batch.item_move",
    operation_version: "1",
    ...userOrigin(),
    params: {},
    inputs: [],
    outputs: [],
    based_on: null,
    supersedes: [],
    deterministic: true,
    status: "pending",
    ...overrides,
  };
}

/**
 * Create a project with its first record, `proj.create`, as the service does.
 * @param opened - the store and its folders.
 * @param id - the project ID text.
 * @returns the project ID and its first record.
 */
function createProject(
  opened: OpenStore,
  id = "project-1",
): { project: ProjectId; first: ProjectRecord } {
  const project = brandString<ProjectId>(id);
  opened.folders.create(
    opened.store,
    project,
    line(null, {
      component: "proj",
      operation: "proj.create",
      params: { title: id },
      status: "done",
    }),
  );
  const [first] = opened.store.listRecords(project);
  if (first === undefined) throw new Error("no first record");
  return { project, first };
}

/**
 * @param fn - a call that should be refused.
 * @returns the code of the `ProjectError` it threw.
 */
function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProjectError) return error.code;
    throw error;
  }
  throw new Error("the call was not refused");
}

/**
 * @param ms - how long to wait.
 * @returns a promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ASSET_X = brandString<AssetId>("asset-x");
const ASSET_Y = brandString<AssetId>("asset-y");

describe("RecordStore", () => {
  it("writes a record line and an update line", () => {
    const opened = openStore();
    const { root, store } = opened;
    const { project, first } = createProject(opened);
    const record = store.append(project, line(first.id));
    const startedAt = new Date().toISOString();
    store.update(project, { update: record.id, status: "running", started_at: startedAt });
    const cost = { wall_seconds: 4.5, reused: false };
    store.update(project, {
      update: record.id,
      status: "done",
      finished_at: startedAt,
      outputs: [ASSET_X],
      cost,
    });

    const lines = readLines(root, project);
    expect(lines).toHaveLength(4);
    expect(Object.keys(lines[1] ?? {})).toEqual([
      "id",
      "parents",
      "kind",
      "component",
      "operation",
      "operation_version",
      "actor",
      "surface",
      "turn",
      "session",
      "tool_call",
      "intent",
      "params",
      "inputs",
      "outputs",
      "based_on",
      "supersedes",
      "deterministic",
      "status",
      "created_at",
    ]);
    expect(lines[2]).toEqual({ update: record.id, status: "running", started_at: startedAt });
    expect(lines[3]).toEqual({
      update: record.id,
      status: "done",
      finished_at: startedAt,
      outputs: [ASSET_X],
      cost,
    });
    expect(store.getRecord(project, record.id)).toEqual({
      ...record,
      status: "done",
      started_at: startedAt,
      finished_at: startedAt,
      outputs: [ASSET_X],
      cost,
    });
    expect(store.line(project)).toEqual({ tip: record.id, at: record.id });
    expect(
      JSON.parse(readFileSync(join(root, project, ".comfy-studio", "line.json"), "utf8")),
    ).toEqual({ tip: record.id, at: record.id });
    expect(store.getProject(project).path).toBe(join(root, project));
    expect(readdirSync(join(root, project))).toEqual([".comfy-studio"]);
    expect(readdirSync(join(root, project, ".comfy-studio")).toSorted()).toEqual([
      "line.json",
      "records.jsonl",
    ]);
  });

  it("refuses an append whose parent is not the current position", () => {
    const opened = openStore();
    const { root, store, events } = opened;
    const { project, first } = createProject(opened);
    store.append(project, line(first.id));
    const before = readFileSync(join(root, project, ".comfy-studio", "records.jsonl"), "utf8");
    const eventCount = events.length;

    expect(errorCode(() => store.append(project, line(first.id)))).toBe("parent_not_head");
    expect(errorCode(() => store.append(project, line(null)))).toBe("parent_not_head");
    expect(readFileSync(join(root, project, ".comfy-studio", "records.jsonl"), "utf8")).toBe(
      before,
    );
    expect(events).toHaveLength(eventCount);
  });

  it("refuses a backward or repeated status", () => {
    const opened = openStore();
    const { store } = opened;
    const { project, first } = createProject(opened);
    const running = store.append(project, line(first.id));
    store.update(project, { update: running.id, status: "running" });
    expect(errorCode(() => store.update(project, { update: running.id, status: "running" }))).toBe(
      "status_backwards",
    );
    expect(errorCode(() => store.update(project, { update: running.id, status: "pending" }))).toBe(
      "status_backwards",
    );
    store.update(project, { update: running.id, status: "done" });
    expect(errorCode(() => store.update(project, { update: running.id, status: "running" }))).toBe(
      "record_finished",
    );
  });

  it("refuses an update of a finished record", () => {
    const opened = openStore();
    const { store } = opened;
    const { project, first } = createProject(opened);
    let head = first.id;
    for (const status of ["done", "failed", "cancelled"] as const) {
      const record = store.append(project, line(head));
      head = record.id;
      store.update(project, { update: record.id, status });
      expect(
        errorCode(() => store.update(project, { update: record.id, report: { late: true } })),
      ).toBe("record_finished");
    }
    expect(
      errorCode(() =>
        store.update(project, { update: brandString<RecordId>("missing"), status: "done" }),
      ),
    ).toBe("unknown_record");
  });

  it("reloads records, updates and the line from disk", () => {
    const opened = openStore();
    const { store } = opened;
    const { project, first } = createProject(opened);
    const record = store.append(project, line(first.id));
    store.update(project, { update: record.id, status: "done", outputs: [ASSET_X] });
    const last = store.append(project, line(record.id));
    store.moveTo(project, record.id);

    const reloaded = openStore(opened.folders).store;
    expect(reloaded.listProjects()).toEqual(store.listProjects());
    expect(reloaded.listRecords(project)).toEqual(store.listRecords(project));
    expect(reloaded.line(project)).toEqual({ tip: last.id, at: record.id });
  });

  it("writes started_by on the record line only when the line has it, and reloads it", () => {
    const opened = openStore();
    const { root, store } = opened;
    const { project, first } = createProject(opened);
    const startedBy = { record: first.id, slot: 2, lane: "wide" };
    const started = store.append(project, line(first.id, { started_by: startedBy }));
    const free = store.append(project, line(started.id));

    const lines = readLines(root, project);
    expect(Object.keys(lines[1] ?? {}).slice(16, 19)).toEqual([
      "supersedes",
      "started_by",
      "deterministic",
    ]);
    expect(lines[1]?.["started_by"]).toEqual(startedBy);
    expect(lines[2]).not.toHaveProperty("started_by");
    expect(store.getRecord(project, started.id).started_by).toEqual(startedBy);
    expect(openStore(opened.folders).store.getRecord(project, started.id).started_by).toEqual(
      startedBy,
    );
    expect(store.getRecord(project, free.id)).not.toHaveProperty("started_by");
  });

  it("moves the current position without writing a record, and appends after it", () => {
    const opened = openStore();
    const { root, store, events } = opened;
    const { project, first } = createProject(opened);
    const second = store.append(project, line(first.id));
    const before = readFileSync(join(root, project, ".comfy-studio", "records.jsonl"), "utf8");
    store.moveTo(project, first.id);
    expect(readFileSync(join(root, project, ".comfy-studio", "records.jsonl"), "utf8")).toBe(
      before,
    );
    expect(store.line(project)).toEqual({ tip: second.id, at: first.id });
    expect(events.at(-1)).toEqual({
      project,
      event: { kind: "line", tip: second.id, at: first.id },
    });
    // A write follows the current position, not the last step, and becomes both.
    expect(errorCode(() => store.append(project, line(second.id)))).toBe("parent_not_head");
    const third = store.append(project, line(first.id));
    expect(store.line(project)).toEqual({ tip: third.id, at: third.id });
    expect(
      errorCode(() => {
        store.moveTo(project, brandString<RecordId>("missing"));
      }),
    ).toBe("unknown_record");
  });

  it("lists the record IDs of the history list with the index of the current position", () => {
    const opened = openStore();
    const { store } = opened;
    const { project, first } = createProject(opened);
    const second = store.append(project, line(first.id));
    const third = store.append(project, line(second.id));
    store.moveTo(project, second.id);
    expect(store.lineIds(project)).toEqual({ ids: [first.id, second.id, third.id], atIndex: 1 });
    // A write after the move leaves `third` out of the list.
    store.moveTo(project, first.id);
    const fourth = store.append(project, line(first.id));
    expect(store.lineIds(project)).toEqual({ ids: [first.id, fourth.id], atIndex: 1 });
  });

  it("fills resolved_asset of an output input once the producer is done", () => {
    const opened = openStore();
    const { root, store } = opened;
    const { project, first } = createProject(opened);
    const producer = store.append(project, line(first.id));
    const consumer = store.append(
      project,
      line(producer.id, {
        inputs: [{ role: "source", ref: { record: producer.id, output: 1 }, resolved_asset: null }],
      }),
    );
    expect(store.getRecord(project, consumer.id).inputs[0]?.resolved_asset).toBeNull();

    store.update(project, { update: producer.id, status: "done", outputs: [ASSET_X, ASSET_Y] });
    expect(store.getRecord(project, consumer.id).inputs[0]?.resolved_asset).toBe(ASSET_Y);
    expect(store.listRecords(project)[2]?.inputs[0]?.resolved_asset).toBe(ASSET_Y);
    const consumerLine = readLines(root, project).find((entry) => entry.id === consumer.id);
    expect(consumerLine?.inputs).toEqual([
      { role: "source", ref: { record: producer.id, output: 1 }, resolved_asset: null },
    ]);
  });

  it("returns copies that callers cannot use to change the store", () => {
    const opened = openStore();
    const { store } = opened;
    const { project, first } = createProject(opened);
    const record = store.getRecord(project, first.id);
    record.params.title = "changed";
    record.parents.push(first.id);
    const listed = store.listRecords(project)[0];
    if (listed !== undefined) listed.status = "failed";
    expect(store.getRecord(project, first.id)).toEqual(first);
  });

  it("serializes work under the project lock", async () => {
    const { store } = openStore();
    const project = brandString<ProjectId>("project-1");
    const other = brandString<ProjectId>("project-2");
    const steps: string[] = [];
    const work = (name: string, ms: number) => async () => {
      steps.push(`${name} start`);
      await delay(ms);
      steps.push(`${name} end`);
      return name;
    };
    const failing = store.lock(project, async () => {
      await work("a", 30)();
      throw new Error("a failed");
    });
    const second = store.lock(project, work("b", 5));
    const concurrent = store.lock(other, work("c", 5));
    await expect(failing).rejects.toThrow("a failed");
    await expect(second).resolves.toBe("b");
    await expect(concurrent).resolves.toBe("c");
    expect(steps.indexOf("b start")).toBeGreaterThan(steps.indexOf("a end"));
    expect(steps.indexOf("c end")).toBeLessThan(steps.indexOf("a end"));
  });

  it("reads a project on first use, refuses to start an existing project, and forgets a removed project", () => {
    const opened = openStore();
    const { store, folders } = opened;
    const { project, first } = createProject(opened);
    expect(errorCode(() => store.getRecord(brandString<ProjectId>("missing"), first.id))).toBe(
      "unknown_project",
    );
    expect(
      errorCode(() => {
        store.createProject(project, join(opened.root, project, ".comfy-studio"));
      }),
    ).toBe("invalid_params");
    expect(readLines(opened.root, project)).toHaveLength(1);

    folders.remove(project);
    store.forget(project);
    expect(errorCode(() => store.listRecords(project))).toBe("unknown_project");
    expect(existsSync(join(opened.root, project, ".comfy-studio", "records.jsonl"))).toBe(true);
  });

  it("emits record, line and update events after the write", () => {
    const opened = openStore();
    const { root, events } = opened;
    const project = brandString<ProjectId>("project-1");
    opened.folders.add(project, "Events");
    // Each event must find its change on disk when it arrives.
    const seen: string[] = [];
    const checked = new RecordStore(opened.folders, (eventProject, event) => {
      const text = readFileSync(join(root, eventProject, ".comfy-studio", "records.jsonl"), "utf8");
      if (event.kind === "record") expect(text).toContain(event.record.id);
      if (event.kind === "update")
        expect(text).toContain(`"update":"${event.record.id}","status":"${event.record.status}"`);
      seen.push(event.kind);
      events.push({ project: eventProject, event });
    });
    checked.createProject(project, join(root, project, ".comfy-studio"));
    expect(events).toEqual([]);
    const first = checked.append(
      project,
      line(null, { component: "proj", operation: "proj.create", status: "done" }),
    );
    const record = checked.append(project, line(first.id));
    const done = checked.update(project, { update: record.id, status: "done", outputs: [ASSET_X] });

    expect(seen).toEqual(["record", "line", "record", "line", "update"]);
    expect(events.map((entry) => entry.event)).toEqual([
      { kind: "record", record: first },
      { kind: "line", tip: first.id, at: first.id },
      { kind: "record", record },
      { kind: "line", tip: record.id, at: record.id },
      { kind: "update", record: done },
    ]);
    expect(done.outputs).toEqual([ASSET_X]);
  });
});
