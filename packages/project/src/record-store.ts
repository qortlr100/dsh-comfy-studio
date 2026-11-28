/**
 * The record store: the only code that reads or writes the records of a project. The store's files live in the
 * project folder's `.comfy-studio/` directory (`PROJECT_DIR`), and the rest of the folder belongs to the user:
 *
 * ```
 * <folder>/.comfy-studio/records.jsonl   record lines and update lines, appended in write order
 * <folder>/.comfy-studio/line.json       ProjectLine: the history list's last step and the current position
 * ```
 *
 * The history list of a project is the `parents[0]` ancestry of its last step (`tip`); `at` is the current position on
 * that list. A new step follows `at` and becomes both `tip` and `at`, so the steps that were after `at` leave the list
 * (they are discarded and stay on disk). A record outside the history also follows `at`, but leaves `line.json` as it
 * is, so it never joins the list and discards nothing. The store loads a project at first use and mirrors each change to disk before
 * it returns. It enforces the record format rules (append only after `at`, status only forward, no update after a
 * record finished) and reports every change to the `onChange` callback after the change is on disk. It does not
 * interpret records or take decisions; the other modules do that and call it while they hold the project lock it
 * provides.
 *
 * @module @cs/project/record-store
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { PROJECT_DIR } from "./folder.ts";
import { ProjectError } from "./shared.ts";
import type {
  ProjectEvent,
  ProjectId,
  ProjectInfo,
  ProjectLine,
  ProjectRecord,
  RecordId,
  RecordStatus,
  RecordUpdate,
} from "./types.ts";

/** A record line as a caller hands it to {@link RecordStore.append}: the store assigns `id` and `created_at`. */
export type RecordLineInput = Omit<
  ProjectRecord,
  "id" | "created_at" | "started_at" | "finished_at" | "error" | "cost" | "report"
>;

/** One project in memory: its `.comfy-studio/` directory, its records with every update line applied, and its `line.json`. */
interface LoadedProject {
  dir: string;
  /** Record ID → the record line with its update lines applied; `resolved_asset` values are as written on disk. */
  records: Map<RecordId, ProjectRecord>;
  /** Record IDs in write order. */
  order: RecordId[];
  /** The last step and the current position; null before the first record. */
  line: ProjectLine | null;
}

/** The order of statuses: an update may only move to a higher rank. */
const STATUS_RANK: Record<RecordStatus, number> = {
  pending: 0,
  running: 1,
  done: 2,
  failed: 2,
  cancelled: 2,
};

/**
 * @param status - a record status.
 * @returns whether the status is final (`done`, `failed` or `cancelled`).
 */
function isFinished(status: RecordStatus): boolean {
  return STATUS_RANK[status] === 2;
}

/**
 * Write a file atomically: write `<file>.tmp`, then rename it over the file.
 * @param file - the file path.
 * @param text - the full contents.
 */
function writeAtomic(file: string, text: string): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** Append-only storage of every project's records and metadata. */
/**
 * The time of a new record: now, or one millisecond after the record written before it when the clock has not moved
 * past that one. So the `created_at` of a project's records strictly increases in write order, and a reducer that
 * receives records out of write order (a record outside the history comes after the steps) can tell which came first.
 * @param previous - the `created_at` of the record written last; undefined for the first record.
 * @returns the time, ISO-8601 UTC.
 */
function laterThan(previous: string | undefined): string {
  const now = Date.now();
  const last = previous === undefined ? Number.NaN : Date.parse(previous);
  return new Date(Number.isNaN(last) || now > last ? now : last + 1).toISOString();
}

export class RecordStore {
  private readonly projects = new Map<ProjectId, LoadedProject>();
  /** Project → the settled tail of its lock chain; the next `lock` call starts after it. */
  private readonly locks = new Map<ProjectId, Promise<void>>();

  private readonly folders: { get(project: ProjectId): ProjectInfo; list(): ProjectInfo[] };
  private readonly onChange: (project: ProjectId, event: ProjectEvent) => void;

  /**
   * @param folders - the projects: `get` throws `unknown_project`, and `path` is the project folder.
   * @param onChange - called after each change is on disk; the subscriptions module fans it out.
   */
  constructor(
    folders: { get(project: ProjectId): ProjectInfo; list(): ProjectInfo[] },
    onChange: (project: ProjectId, event: ProjectEvent) => void,
  ) {
    this.folders = folders;
    this.onChange = onChange;
  }

  /**
   * Read a project into memory: `records.jsonl` is replayed in file order, so a record line adds a record and an update
   * line applies to the record it names.
   * @param project - a project ID; throws `unknown_project`.
   * @returns the project in memory.
   */
  private open(project: ProjectId): LoadedProject {
    const dir = join(this.folders.get(project).path, PROJECT_DIR);
    const loaded: LoadedProject = { dir, records: new Map(), order: [], line: null };
    for (const line of readFileSync(join(dir, "records.jsonl"), "utf8").split("\n")) {
      if (line === "") continue;
      // Every line was written by this store, in its own record format.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const parsed = JSON.parse(line) as ProjectRecord | RecordUpdate;
      if ("update" in parsed) {
        const record = loaded.records.get(parsed.update);
        if (record === undefined)
          throw new Error(
            `${join(dir, "records.jsonl")}: update line for unknown record ${parsed.update}`,
          );
        applyUpdate(record, parsed);
      } else {
        loaded.records.set(parsed.id, parsed);
        loaded.order.push(parsed.id);
      }
    }
    const linePath = join(dir, "line.json");
    const last = loaded.order.at(-1);
    if (existsSync(linePath))
      // line.json was written by this store, in its own format.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      loaded.line = JSON.parse(readFileSync(linePath, "utf8")) as ProjectLine;
    else if (last !== undefined) loaded.line = { tip: last, at: last };
    this.projects.set(project, loaded);
    return loaded;
  }

  /**
   * Run a function while holding the project's lock. Calls for the same project run one at a time in call order;
   * calls for different projects do not wait for each other. The lock is not reentrant.
   * @param project - the project.
   * @param fn - the work to do under the lock.
   * @returns what `fn` returns.
   */
  lock<T>(project: ProjectId, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(project) ?? Promise.resolve();
    const result = previous.then(fn);
    // The chain continues after `fn` settles either way; the stored tail never rejects.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(project, tail);
    void tail.then(() => {
      if (this.locks.get(project) === tail) this.locks.delete(project);
      return undefined;
    });
    return result;
  }

  /**
   * Start a project with no record in its `.comfy-studio/` directory, created when missing; `records.jsonl` appears with
   * the first {@link append}.
   * @param project - the project, which has no `records.jsonl` yet.
   * @param dir - the project folder's `.comfy-studio/` directory.
   */
  createProject(project: ProjectId, dir: string): void {
    if (existsSync(join(dir, "records.jsonl"))) {
      throw new ProjectError("invalid_params", `A project with ID ${project} already exists.`);
    }
    mkdirSync(dir, { recursive: true });
    this.projects.set(project, { dir, records: new Map(), order: [], line: null });
  }

  /** @returns every project's metadata, oldest first. */
  listProjects(): ProjectInfo[] {
    return this.folders.list();
  }

  /**
   * @param project - a project.
   * @returns its metadata; throws `unknown_project`.
   */
  getProject(project: ProjectId): ProjectInfo {
    return this.folders.get(project);
  }

  /**
   * Drop a project from memory; its files stay. A later call that names the project reads it again.
   * @param project - a project.
   */
  forget(project: ProjectId): void {
    this.projects.delete(project);
  }

  /**
   * Append a record line as a step. Rule: `parents` must be `[at]`, else `parent_not_head`; the first record of a
   * project has `parents: []`. The new record becomes both the last step and the current position.
   * @param project - the project.
   * @param line - the record without `id` and `created_at`.
   * @returns the stored record.
   */
  append(project: ProjectId, line: RecordLineInput): ProjectRecord {
    const loaded = this.loaded(project);
    const stored = this.writeRecord(project, loaded, line);
    loaded.line = { tip: stored.id, at: stored.id };
    writeAtomic(this.file(project, "line.json"), `${JSON.stringify(loaded.line)}\n`);
    const current = this.currentForm(loaded, stored);
    this.onChange(project, { kind: "record", record: current });
    this.onChange(project, { kind: "line", ...loaded.line });
    return current;
  }

  /**
   * Append a record line outside the history: the same rule as {@link append}, but `line.json` keeps its `tip` and
   * `at`, so the record joins no history list and no `line` event follows its `record` event.
   * @param project - the project.
   * @param line - the record without `id` and `created_at`; `parents` is `[at]`.
   * @returns the stored record.
   */
  appendOutsideHistory(project: ProjectId, line: RecordLineInput): ProjectRecord {
    const loaded = this.loaded(project);
    const current = this.currentForm(loaded, this.writeRecord(project, loaded, line));
    this.onChange(project, { kind: "record", record: current });
    return current;
  }

  /**
   * Check the parent rule of {@link append}, then write the record line to `records.jsonl` and to memory.
   * @param project - the project.
   * @param loaded - the project in memory.
   * @param line - the record without `id` and `created_at`.
   * @returns the stored record (not a copy).
   */
  private writeRecord(
    project: ProjectId,
    loaded: LoadedProject,
    line: RecordLineInput,
  ): ProjectRecord {
    const at = loaded.line?.at;
    // Check the parent rule before anything is written.
    if (
      at === undefined
        ? line.parents.length !== 0
        : line.parents.length !== 1 || line.parents[0] !== at
    ) {
      throw new ProjectError(
        "parent_not_head",
        `Cannot append to project ${project}: the record's parent is not the current position ${at ?? "(none)"}.`,
      );
    }
    const lastId = loaded.order.at(-1);
    const lastWritten = lastId === undefined ? undefined : loaded.records.get(lastId);
    // Exactly the record-line fields, in record-format order.
    const record: ProjectRecord = {
      id: brandString<RecordId>(randomUUID()),
      parents: [...line.parents],
      kind: line.kind,
      component: line.component,
      operation: line.operation,
      operation_version: line.operation_version,
      actor: line.actor,
      surface: line.surface,
      turn: line.turn,
      session: line.session,
      tool_call: line.tool_call,
      intent: line.intent,
      params: line.params,
      inputs: line.inputs,
      outputs: line.outputs,
      based_on: line.based_on,
      supersedes: line.supersedes,
      ...(line.started_by === undefined ? {} : { started_by: line.started_by }),
      deterministic: line.deterministic,
      status: line.status,
      created_at: laterThan(lastWritten?.created_at),
    };
    const stored = structuredClone(record);
    appendFileSync(this.file(project, "records.jsonl"), `${JSON.stringify(stored)}\n`);
    loaded.records.set(stored.id, stored);
    loaded.order.push(stored.id);
    return stored;
  }

  /**
   * Append an update line. Rules: the record must exist (`unknown_record`) and must not be finished
   * (`record_finished`); `status`, when given, must move forward (`status_backwards`).
   * @param project - the project.
   * @param update - the update line.
   * @returns the record's current form after the update.
   */
  update(project: ProjectId, update: RecordUpdate): ProjectRecord {
    const loaded = this.loaded(project);
    const record = loaded.records.get(update.update);
    if (record === undefined)
      throw new ProjectError(
        "unknown_record",
        `Project ${project} has no record ${update.update}.`,
      );
    if (isFinished(record.status)) {
      throw new ProjectError(
        "record_finished",
        `Record ${record.id} of project ${project} already ended ${record.status}.`,
      );
    }
    if (update.status !== undefined && STATUS_RANK[update.status] <= STATUS_RANK[record.status]) {
      throw new ProjectError(
        "status_backwards",
        `Record ${record.id} of project ${project} cannot move from ${record.status} to ${update.status}.`,
      );
    }
    // Exactly the fields the caller set, in update-line order.
    const line: RecordUpdate = { update: update.update };
    if (update.status !== undefined) line.status = update.status;
    if (update.started_at !== undefined) line.started_at = update.started_at;
    if (update.finished_at !== undefined) line.finished_at = update.finished_at;
    if (update.outputs !== undefined) line.outputs = update.outputs;
    if (update.error !== undefined) line.error = update.error;
    if (update.cost !== undefined) line.cost = update.cost;
    if (update.report !== undefined) line.report = update.report;
    const stored = structuredClone(line);
    appendFileSync(this.file(project, "records.jsonl"), `${JSON.stringify(stored)}\n`);
    applyUpdate(record, stored);
    const current = this.currentForm(loaded, record);
    this.onChange(project, { kind: "update", record: current });
    return current;
  }

  /**
   * @param project - the project.
   * @param record - a record ID.
   * @returns the record's current form; throws `unknown_record`.
   */
  getRecord(project: ProjectId, record: RecordId): ProjectRecord {
    const loaded = this.loaded(project);
    return this.currentForm(loaded, this.storedRecord(project, loaded, record));
  }

  /**
   * @param project - the project.
   * @param keep - which stored records to return; every record when omitted.
   * @returns the current form of each kept record, in write order.
   */
  listRecords(project: ProjectId, keep?: (record: ProjectRecord) => boolean): ProjectRecord[] {
    const loaded = this.loaded(project);
    const stored = loaded.order.map((id) => this.storedRecord(project, loaded, id));
    return (keep === undefined ? stored : stored.filter(keep)).map((record) =>
      this.currentForm(loaded, record),
    );
  }

  /**
   * Walk `parents[0]` from a record to the project's first record.
   * @param project - the project.
   * @param record - the record to start from.
   * @returns the records from the first record to `record`, inclusive, oldest first.
   */
  ancestors(project: ProjectId, record: RecordId): ProjectRecord[] {
    const loaded = this.loaded(project);
    const chain: ProjectRecord[] = [];
    let next: RecordId | undefined = record;
    while (next !== undefined) {
      const stored = this.storedRecord(project, loaded, next);
      chain.push(this.currentForm(loaded, stored));
      next = stored.parents[0];
    }
    return chain.toReversed();
  }

  /**
   * @param project - the project.
   * @returns the last step of the history list and the current position, or undefined before the first record.
   */
  line(project: ProjectId): ProjectLine | undefined {
    const line = this.loaded(project).line;
    return line === null ? undefined : { ...line };
  }

  /**
   * @param project - the project.
   * @returns the last step of the history list and the current position; throws `invalid_params` before the first
   *   record.
   */
  requireLine(project: ProjectId): ProjectLine {
    const line = this.line(project);
    if (line === undefined)
      throw new ProjectError("invalid_params", `Project ${project} has no record yet.`);
    return line;
  }

  /**
   * The record IDs of the history list, read without copying any record.
   * @param project - the project.
   * @returns the IDs of the `parents[0]` ancestry of `tip`, oldest first, and the index of `at` in them; empty with
   *   index -1 before the first record.
   */
  lineIds(project: ProjectId): { ids: RecordId[]; atIndex: number } {
    const loaded = this.loaded(project);
    if (loaded.line === null) return { ids: [], atIndex: -1 };
    const ids: RecordId[] = [];
    let next: RecordId | undefined = loaded.line.tip;
    while (next !== undefined) {
      ids.push(next);
      next = this.storedRecord(project, loaded, next).parents[0];
    }
    ids.reverse();
    return { ids, atIndex: ids.indexOf(loaded.line.at) };
  }

  /**
   * Move the current position, and rewrite `line.json` atomically. `at` must be a record of the history list; the
   * caller checks that.
   * @param project - the project.
   * @param at - the new current position.
   */
  moveTo(project: ProjectId, at: RecordId): void {
    const loaded = this.loaded(project);
    if (loaded.line === null)
      throw new ProjectError("unknown_record", `Project ${project} has no record ${at}.`);
    this.storedRecord(project, loaded, at);
    loaded.line = { tip: loaded.line.tip, at };
    writeAtomic(this.file(project, "line.json"), `${JSON.stringify(loaded.line)}\n`);
    this.onChange(project, { kind: "line", ...loaded.line });
  }

  /**
   * @param project - a project ID.
   * @param name - a file name of the store.
   * @returns the file's path in the project's `.comfy-studio/` directory.
   */
  private file(project: ProjectId, name: "records.jsonl" | "line.json"): string {
    return join(this.loaded(project).dir, name);
  }

  /**
   * @param project - a project ID.
   * @returns the project in memory, read on first use; throws `unknown_project`.
   */
  private loaded(project: ProjectId): LoadedProject {
    return this.projects.get(project) ?? this.open(project);
  }

  /**
   * @param project - the project ID, for the error message.
   * @param loaded - the project in memory.
   * @param record - a record ID.
   * @returns the stored record (not a copy); throws `unknown_record`.
   */
  private storedRecord(project: ProjectId, loaded: LoadedProject, record: RecordId): ProjectRecord {
    const stored = loaded.records.get(record);
    if (stored === undefined)
      throw new ProjectError("unknown_record", `Project ${project} has no record ${record}.`);
    return stored;
  }

  /**
   * The current form of a stored record: a copy whose `{record, output}` inputs carry the producer's
   * `outputs[output]` as `resolved_asset` once the producer is `done`.
   * @param loaded - the project in memory.
   * @param stored - the stored record.
   * @returns a copy the caller may change.
   */
  private currentForm(loaded: LoadedProject, stored: ProjectRecord): ProjectRecord {
    const current = structuredClone(stored);
    for (const input of current.inputs) {
      if (input.resolved_asset !== null || !("record" in input.ref)) continue;
      const producer = loaded.records.get(input.ref.record);
      if (producer?.status === "done")
        input.resolved_asset = producer.outputs[input.ref.output] ?? null;
    }
    return current;
  }
}

/**
 * Apply an update line to a stored record in place.
 * @param record - the stored record.
 * @param update - the update line.
 */
function applyUpdate(record: ProjectRecord, update: RecordUpdate): void {
  const { update: _id, ...fields } = update;
  Object.assign(record, fields);
}
