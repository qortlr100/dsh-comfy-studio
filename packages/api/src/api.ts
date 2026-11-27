/**
 * The handlers behind the browser routes, independent of transport: list, create, rename, remove and summarize
 * projects, read the project state, list operations, run an operation as the human, undo and redo, accept a stale
 * record, and list the history. The Fetch routes and the tests call these methods directly.
 *
 * Every write goes through `csProject` with actor `user`, the surface the request names, and the chat session the view
 * sits beside (`session`, when the request names one); it becomes a step after the project's current position.
 *
 * @module @cs/api/api
 */
import { basename } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { ProjectError } from "@cs/project";
import type CsProject from "@cs/project";
import type {
  Actor,
  AssetId,
  HistoryEntry,
  HistoryQuery,
  OperationCheck,
  ProjectId,
  ProjectInfo,
  ProjectLine,
  ProjectRecord,
  RecordId,
  RecordKind,
  RecordOrigin,
  RecordStatus,
  RunRequest,
  SessionId,
  TurnId,
} from "@cs/project";
import { summarizeProject, type WireProjectSummary } from "./summaries.ts";
import {
  projectIdOf,
  toWireOperation,
  toWireState,
  type WireAsset,
  type WireHistory,
  type WireOperation,
  type WireProject,
  type WireState,
} from "./wire.ts";

/**
 * A request a route could not serve, with the HTTP status that answers it and its error code: `invalid_params` for a
 * malformed request, `unknown_project` for an unknown project, else the `ProjectError` code.
 */
export class ApiRequestError extends Error {
  readonly status: 400 | 404 | 409;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: 400 | 404 | 409,
    message: string,
    code: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = "ApiRequestError";
  }
}

/** The surfaces a view may name; a request from our own views is `view`, one from the chat panel is `chat`. */
export type RequestSurface = "chat" | "view";

/** What a view sends to run an operation (`POST /api/cs/operation`). */
export interface OperationRequest {
  project: string;
  operation: string;
  /** The inputs by role; `ref` is reference text: `<asset>`, `<record>#<output>`, or `<id>@<version>`. */
  inputs?: Array<{ role: string; ref: string }>;
  params?: Record<string, unknown>;
  intent?: string;
  /** Anything but `chat` counts as `view`. */
  surface?: RequestSurface;
  /** The chat session the view sits beside, recorded as the record's `session`. */
  session?: string;
  based_on?: string;
  supersedes?: string[];
}

/**
 * The text of a thrown value.
 * @param error - what a call threw.
 * @returns the error's message, or the value as text.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A JSON response with no caching.
 * @param value - the body.
 * @param status - the HTTP status.
 * @returns the response.
 */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The HTTP status of each refused Project call that a browser request can cause; any other code answers 409. */
const STATUS_OF: Partial<Record<ProjectError["code"], 400 | 404 | 409>> = {
  unknown_project: 404,
  unknown_record: 404,
  unknown_operation: 404,
  unknown_asset: 404,
  invalid_params: 400,
  invalid_inputs: 400,
  input_not_ready: 400,
};

/**
 * Run a route body and answer with its JSON value, or with the error body `{error, code, ...details}` of every
 * `/api/cs` route and `/cs/events`: an {@link ApiRequestError} with its status and code, a `ProjectError` with the
 * status of its code, anything else with 500 and code `internal_error`.
 * @param run - the route body.
 * @param onInternalError - told about each failure answered with 500, so the host can log it.
 * @returns the JSON response.
 */
export async function answer(
  run: () => unknown,
  onInternalError?: (error: unknown) => void,
): Promise<Response> {
  try {
    return json(await run());
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return json({ ...error.details, error: error.message, code: error.code }, error.status);
    }
    if (error instanceof ProjectError) {
      return json({ error: error.message, code: error.code }, STATUS_OF[error.code] ?? 409);
    }
    onInternalError?.(error);
    return json({ error: messageOf(error), code: "internal_error" }, 500);
  }
}

/**
 * The project a request names, checked to exist.
 * @param project - the Project service.
 * @param value - the raw project ID.
 * @returns the project ID.
 * @throws ApiRequestError `invalid_params` when it is malformed, `unknown_project` when it names no project.
 */
export function requireProject(project: Pick<CsProject, "openProject">, value: unknown): ProjectId {
  const projectId = projectIdOf(value);
  if (projectId === null) {
    throw new ApiRequestError(400, "'project' must name a project.", "invalid_params");
  }
  try {
    project.openProject(projectId);
  } catch {
    // Project throws for an unknown project; the request names no project.
    throw new ApiRequestError(404, `Unknown project '${projectId}'.`, "unknown_project");
  }
  return projectId;
}

/**
 * Run a Project call and turn its refusal into a request error with the matching status and code.
 * @param call - the call.
 * @returns the call's result.
 */
async function refused<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProjectError) {
      throw new ApiRequestError(STATUS_OF[error.code] ?? 409, error.message, error.code);
    }
    throw error;
  }
}

/**
 * @param value - a raw JSON value.
 * @returns whether the value is a plain object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param value - a raw JSON value.
 * @returns the value when it is a plain object, else an empty object.
 */
export function objectOf(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

/** @returns an `invalid_params` refusal with the given sentence. */
function invalid(message: string): ApiRequestError {
  return new ApiRequestError(400, message, "invalid_params");
}

/**
 * @param value - a raw JSON value.
 * @param field - the field name for the error.
 * @returns the string.
 * @throws ApiRequestError (400, code `invalid_params`) when the value is not a non-empty string.
 */
function stringOf(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`'${field}' must be a non-empty string.`);
  }
  return value;
}

/** The longest folder or project name a request may give, in UTF-8 bytes; file systems stop at 255. */
const NAME_BYTES = 200;

/**
 * @param value - a raw JSON value.
 * @param field - the field name for the error.
 * @returns the string, fit to name a folder or a project.
 * @throws ApiRequestError (400, code `invalid_params`) when the value is not a non-empty string, holds a control
 *   character, or is longer than {@link NAME_BYTES} bytes.
 */
function nameOf(value: unknown, field: string): string {
  const name = stringOf(value, field);
  // oxlint-disable-next-line eslint/no-control-regex -- control characters are what this refuses.
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw invalid(`'${field}' must not contain control characters.`);
  }
  if (Buffer.byteLength(name) > NAME_BYTES) {
    throw invalid(`'${field}' must be at most ${String(NAME_BYTES)} bytes.`);
  }
  return name;
}

/**
 * @param error - what a file system call threw.
 * @returns whether it says the path does not exist or is not a folder.
 */
function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/**
 * @param value - the raw `surface` of a request.
 * @returns the surface; anything but `chat` counts as one of our views.
 */
function surfaceOf(value: unknown): RequestSurface {
  return value === "chat" ? "chat" : "view";
}

/** The values each enumerated history filter accepts. */
const HISTORY_ACTORS: readonly Actor[] = ["user", "agent", "system"];
const HISTORY_KINDS: readonly RecordKind[] = ["operation"];
const HISTORY_STATUSES: readonly RecordStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
];

/** The number of entries a history request returns when it names no limit, and the most it may ask for. */
const HISTORY_LIMIT = { default: 50, max: 200 } as const;

/**
 * The filters of a history request body, checked.
 * @param body - the request body.
 * @param project - the project, already checked.
 * @returns the history query.
 * @throws ApiRequestError (400, code `invalid_params`) when a filter has the wrong type or an unknown value.
 */
function historyQueryOf(body: Record<string, unknown>, project: ProjectId): HistoryQuery {
  /** A free-form string filter, or undefined when the request leaves it out. */
  const text = (field: string): string | undefined => {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    return stringOf(value, field);
  };
  /** An enumerated filter, or undefined when the request leaves it out. */
  const oneOf = <T extends string>(field: string, allowed: readonly T[]): T | undefined => {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    const found = allowed.find((item) => item === value);
    if (found === undefined) throw invalid(`'${field}' must be one of ${allowed.join(", ")}.`);
    return found;
  };

  const query: HistoryQuery = { project };
  const component = text("component");
  if (component !== undefined) query.component = component;
  const operation = text("operation");
  if (operation !== undefined) query.operation = operation;
  const session = text("session");
  if (session !== undefined) query.session = brandString<SessionId>(session);
  const turn = text("turn");
  if (turn !== undefined) query.turn = brandString<TurnId>(turn);
  const toolCall = text("tool_call");
  if (toolCall !== undefined) query.tool_call = toolCall;
  const before = text("before");
  if (before !== undefined) query.before = brandString<RecordId>(before);
  const actor = oneOf("actor", HISTORY_ACTORS);
  if (actor !== undefined) query.actor = actor;
  const kind = oneOf("kind", HISTORY_KINDS);
  if (kind !== undefined) query.kind = kind;
  const status = oneOf("status", HISTORY_STATUSES);
  if (status !== undefined) query.status = status;

  const records: unknown = body["records"];
  if (records !== undefined && records !== null) {
    if (!Array.isArray(records)) throw invalid("'records' must be an array of strings.");
    query.records = records.map((item: unknown) => {
      if (typeof item !== "string") throw invalid("'records' must be an array of strings.");
      return brandString<RecordId>(item);
    });
  }
  const limit = body["limit"] ?? HISTORY_LIMIT.default;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > HISTORY_LIMIT.max
  ) {
    throw invalid(`'limit' must be an integer from 1 to ${String(HISTORY_LIMIT.max)}.`);
  }
  query.limit = limit;
  return query;
}

/**
 * @param value - the raw `session` of a request.
 * @returns the chat session, or null when the request names none.
 */
export function sessionOf(value: unknown): SessionId | null {
  return typeof value === "string" && value.length > 0 ? brandString<SessionId>(value) : null;
}

/**
 * The origin of a human action from a view.
 * @param body - the request body, for `surface` and `session`.
 * @param intent - what the action does, in words a creator can read.
 * @returns the origin.
 */
function humanOrigin(body: Record<string, unknown>, intent: string): RecordOrigin {
  return {
    actor: "user",
    surface: surfaceOf(body["surface"]),
    session: sessionOf(body["session"]),
    turn: null,
    tool_call: null,
    intent,
  };
}

/** Reads and writes projects on behalf of the browser views. */
export class ApiHandlers {
  private readonly project: CsProject;
  /** The create in flight, so the next one picks its title from a list that already holds this one. */
  private creating: Promise<unknown> = Promise.resolve();

  /** @param project - the Project service every handler reads and writes through. */
  constructor(project: CsProject) {
    this.project = project;
  }

  /** @returns every project, newest first. */
  listProjects(): WireProject[] {
    return this.project
      .listProjects()
      .map((info) => ({
        id: info.id,
        title: info.title,
        created_at: info.created_at,
        path: info.path,
      }))
      .toSorted((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * The card summary of every project, in the order of `csProject.listProjects()`, or of the one project the request
   * names: the cover and the last edit time, read from the project's current state. In the list of every project, a
   * project whose state cannot be read or summarized gets an empty entry (`cover` and `edited_at` null) and a console
   * warning, so the other projects still arrive.
   * @param project - the raw `project` query value; null summarizes every project.
   * @returns one summary per project.
   * @throws ApiRequestError `invalid_params` when `project` is malformed, `unknown_project` when it names no project;
   *   with `project`, also whatever its state read throws.
   */
  listProjectSummaries(project: string | null = null): WireProjectSummary[] {
    const mimeOf = (id: AssetId): string | null => this.assetOrNull(id)?.mime ?? null;
    if (project !== null) {
      const projectId = this.requireProject(project);
      return [summarizeProject(projectId, this.project.getState(projectId), mimeOf)];
    }
    return this.project.listProjects().map((info) => {
      try {
        return summarizeProject(info.id, this.project.getState(info.id), mimeOf);
      } catch (error) {
        // One unreadable project must not hide the cards of the others.
        console.warn(`csApi: project ${info.id} summary failed: ${messageOf(error)}`);
        return { project: info.id, cover: null, edited_at: null };
      }
    });
  }

  /**
   * Start a project from a view, in a fresh folder named after it in the projects folder, or make a chat's folder a
   * project, titled after the folder's name; a folder that is a project already keeps its records and title. A title
   * another listed project already has gets the next free number, so two clients that pick the same name (two tabs, a
   * double click) create two distinct titles.
   * @param raw - `{title, surface?}`, or `{folder, session}` from the chat session `session` (surface `chat`).
   * @returns the project, with the title it was created with.
   * @throws ApiRequestError (400, code `invalid_params`) for a title or folder that cannot name a project, or a
   *   folder that does not exist.
   */
  createProject(raw: unknown): Promise<ProjectInfo> {
    // Creates run one at a time: each picks its free title after the one before it is listed.
    const created = this.creating.then(() => this.createOne(raw));
    this.creating = created.catch(() => undefined);
    return created;
  }

  /** One create; see {@link createProject}. */
  private async createOne(raw: unknown): Promise<ProjectInfo> {
    const body = objectOf(raw);
    if (body["folder"] !== undefined) {
      const folder = stringOf(body["folder"], "folder");
      const name = basename(folder);
      if (name === "") throw invalid("'folder' must name a folder with a name.");
      const title = this.freeTitle(name);
      try {
        return await refused(() =>
          this.project.createProject(folder, title, {
            ...humanOrigin(body, `create project ${title}`),
            surface: "chat",
          }),
        );
      } catch (error) {
        if (isMissingPath(error)) throw invalid("'folder' must be an existing folder.");
        throw error;
      }
    }
    const title = this.freeTitle(nameOf(body["title"], "title"));
    const folder = await refused(() => this.project.newProjectFolder(title));
    return refused(() =>
      this.project.createProject(folder, title, {
        ...humanOrigin(body, `create project ${title}`),
        session: null,
      }),
    );
  }

  /**
   * Make an empty folder in the projects folder for a chat that has no project yet.
   * @param raw - `{name}`, the folder name, such as the view's "Untitled project".
   * @returns `{path}`, the folder.
   */
  async untitledFolder(raw: unknown): Promise<{ path: string }> {
    const name = nameOf(objectOf(raw)["name"], "name");
    return { path: await refused(() => this.project.newProjectFolder(name)) };
  }

  /**
   * Store a project title that no other project has; Project appends ` 2`, ` 3`, … on a clash.
   * @param raw - `{project, title}`.
   * @returns `{title}`, the stored title.
   */
  async renameProject(raw: unknown): Promise<{ title: string }> {
    const body = objectOf(raw);
    const projectId = this.requireProject(body["project"]);
    const title = nameOf(body["title"], "title");
    const info = await refused(() => this.project.renameProject(projectId, title));
    return { title: info.title };
  }

  /**
   * Remove a project from the list. Its DSH Workspace is unregistered; its folder stays on disk, so adding the folder
   * again restores the project.
   * @param raw - `{project}`.
   * @returns `{ok: true}`.
   */
  async removeProject(raw: unknown): Promise<{ ok: true }> {
    const projectId = this.requireProject(objectOf(raw)["project"]);
    await refused(() => this.project.removeProject(projectId));
    return { ok: true };
  }

  /**
   * @param wanted - the requested project title.
   * @returns the title itself when no listed project has it; else its base (without a trailing number) followed by the
   *   lowest free number from the requested one, or from 2, upwards. A trailing number of more than nine digits is
   *   part of the name, not a counter: the title is the base and the count starts at 2.
   */
  private freeTitle(wanted: string): string {
    const taken = new Set(this.project.listProjects().map((info) => info.title));
    if (!taken.has(wanted)) return wanted;
    // Nine digits at most, so the counter stays an exact integer however far it counts: past 2^53 adding one
    // changes nothing and the loop below would never end.
    const numbered = /^(.*\S)\s+(\d{1,9})$/.exec(wanted);
    const base = numbered?.[1] ?? wanted;
    let n = numbered === null ? 2 : Number(numbered[2]) + 1;
    while (taken.has(`${base} ${String(n)}`)) n += 1;
    return `${base} ${String(n)}`;
  }

  /**
   * The project's current state.
   * @param project - the raw project ID.
   * @returns the wire state, with every asset the current state mentions.
   * @throws ApiRequestError when the project is unknown.
   */
  getState(project: unknown): WireState {
    const projectId = this.requireProject(project);
    return toWireState(this.project.getState(projectId), this.project.line(projectId), (id) =>
      this.assetOrNull(id),
    );
  }

  /** @returns the declaration of every registered operation that a view can run: every operation that is not `readOnly`. */
  listOperations(): WireOperation[] {
    return this.project
      .listOperations()
      .filter((spec) => spec.readOnly !== true)
      .map(toWireOperation);
  }

  /**
   * Run an operation as the human, from a view. The record goes after the current position of the project's history.
   * A call whose inputs name an unfinished record is scheduled to run once that record is done.
   * @param raw - the {@link OperationRequest}.
   * @returns the record, finished or pending.
   * @throws ApiRequestError when the body or the operation is unknown, or Project refuses the call.
   */
  async runOperation(raw: unknown): Promise<ProjectRecord> {
    const request = await this.runRequestOf(objectOf(raw));
    const result = await refused(() => this.project.run(request));
    // `runRequestOf` refused every read, so a run without a record is a broken operation.
    if (result.record === null) throw new Error(`'${request.operation}' wrote no record.`);
    return result.record;
  }

  /**
   * Check an operation call as {@link runOperation} would run it, writing nothing: the refusal sentence that the call
   * would get now. An unknown operation, a read, and an input text that does not parse are refusals too.
   * @param raw - the {@link OperationRequest}.
   * @returns the check; `problems` is empty when the call can run on the current state.
   * @throws ApiRequestError when the body or the project is unknown.
   */
  async checkOperation(raw: unknown): Promise<OperationCheck> {
    try {
      return await this.project.check(await this.runRequestOf(objectOf(raw)));
    } catch (error) {
      if (
        !(error instanceof ApiRequestError) ||
        !["invalid_inputs", "unknown_operation", "read_only_operation"].includes(error.code)
      ) {
        throw error;
      }
      return { problems: [error.message] };
    }
  }

  /**
   * The run request of one {@link OperationRequest}: the human origin, the parsed inputs, and `after` when an input
   * names a producer that has not finished.
   * @param body - the request body.
   * @returns the request.
   * @throws ApiRequestError when the project or the operation is unknown, the operation is a read, or an input does
   *   not parse.
   */
  private async runRequestOf(body: Record<string, unknown>): Promise<RunRequest> {
    const projectId = this.requireProject(body["project"]);
    const operation = stringOf(body["operation"], "operation");
    const spec = this.project.listOperations().find((candidate) => candidate.name === operation);
    if (spec === undefined) {
      throw new ApiRequestError(404, `Unknown operation '${operation}'.`, "unknown_operation");
    }
    // A read writes no record and is not in the operation list of a view; refusing it here keeps it from running.
    if (spec.readOnly === true) {
      throw new ApiRequestError(
        400,
        `'${operation}' is a read; a view cannot run it.`,
        "read_only_operation",
      );
    }
    const surface = surfaceOf(body["surface"]);
    const intent =
      typeof body["intent"] === "string" && body["intent"].length > 0
        ? body["intent"]
        : `${surface}: ${operation}`;
    const origin = humanOrigin(body, intent);
    const state = await refused(() => this.project.getState(projectId));
    const byRole = this.inputsByRole(body["inputs"]);
    let inputs: RunRequest["inputs"];
    try {
      inputs = this.project.parseInputs(operation, byRole, state, operation);
    } catch (error) {
      // Project's input parser explains an unknown role or a malformed reference; the request is at fault.
      throw new ApiRequestError(
        400,
        messageOf(error),
        error instanceof ProjectError ? error.code : "invalid_inputs",
      );
    }
    const request: RunRequest = {
      ...origin,
      project: projectId,
      operation,
      params: objectOf(body["params"]),
      inputs,
    };
    if (typeof body["based_on"] === "string") {
      request.based_on = brandString<RecordId>(body["based_on"]);
    }
    const supersedes: unknown = body["supersedes"];
    if (Array.isArray(supersedes)) {
      request.supersedes = supersedes.flatMap((id: unknown) =>
        typeof id === "string" ? [brandString<RecordId>(id)] : [],
      );
    }
    if (await refused(() => this.waitsForProducer(projectId, inputs))) request.after = [];
    return request;
  }

  /**
   * Move the current position one step back, or with `to` to that step of the history list. Writes no record.
   * @param raw - `{project, to?}`.
   * @returns the last step and the current position afterwards.
   */
  async undo(raw: unknown): Promise<ProjectLine> {
    const body = objectOf(raw);
    const projectId = this.requireProject(body["project"]);
    if (body["to"] === undefined) return refused(() => this.project.undo(projectId));
    const to = brandString<RecordId>(stringOf(body["to"], "to"));
    return refused(() => this.project.moveTo(projectId, to));
  }

  /**
   * Move the current position one step forward. Writes no record.
   * @param raw - `{project}`.
   * @returns the last step and the current position afterwards.
   */
  async redo(raw: unknown): Promise<ProjectLine> {
    const projectId = this.requireProject(objectOf(raw)["project"]);
    return refused(() => this.project.redo(projectId));
  }

  /**
   * Accept a stale record as it is: a `proj.stale_accept` record after the current position removes its stale mark and
   * the marks of the records made from it.
   * @param raw - `{project, record, session?, surface?}`.
   * @returns the `proj.stale_accept` record.
   * @throws ApiRequestError (404, code `unknown_record`) when the record does not exist.
   */
  async acceptStale(raw: unknown): Promise<ProjectRecord> {
    const body = objectOf(raw);
    const projectId = this.requireProject(body["project"]);
    const target = brandString<RecordId>(stringOf(body["record"], "record"));
    return refused(() =>
      this.project.acceptStale(projectId, target, humanOrigin(body, `accept ${target}`)),
    );
  }

  /**
   * List a project's records, newest first, through `csProject.listHistory` (the query behind `cs_proj_history_list`).
   * A read: it writes no record.
   * @param raw - the history query: `{project, actor?, component?, operation?, kind?, status?, session?, turn?,
   *   tool_call?, records?, before?, limit?}`; `limit` is 1 to 200, default 50.
   * @returns the entries and every asset they name.
   * @throws ApiRequestError (400 `invalid_params`, 404 `unknown_project`, 404 `unknown_record` for `before`).
   */
  async listHistory(raw: unknown): Promise<WireHistory> {
    const body = objectOf(raw);
    const projectId = this.requireProject(body["project"]);
    const query = historyQueryOf(body, projectId);
    const entries: HistoryEntry[] = await refused(() => this.project.listHistory(query));
    const named = new Set<AssetId>();
    for (const { record } of entries) {
      for (const id of record.outputs) named.add(id);
      for (const input of record.inputs) {
        if (input.resolved_asset !== null) named.add(input.resolved_asset);
      }
    }
    const assets = [...named].flatMap((id) => {
      const asset = this.assetOrNull(id);
      return asset === null ? [] : [asset];
    });
    return { entries, assets };
  }

  /**
   * @param value - a raw project ID.
   * @returns the project ID.
   * @throws ApiRequestError `invalid_params` when it is malformed, `unknown_project` when it names no project.
   */
  private requireProject(value: unknown): ProjectId {
    return requireProject(this.project, value);
  }

  /**
   * The inputs of a request grouped by role, the form Project's input parser reads.
   * @param value - the raw `inputs`: an array of `{role, ref}`.
   * @returns the refs by role.
   * @throws ApiRequestError when an entry lacks a role or a ref.
   */
  private inputsByRole(value: unknown): Record<string, string[]> {
    if (value === undefined) return {};
    if (!Array.isArray(value)) throw invalid("'inputs' must be an array.");
    // A map, so a role named like an `Object.prototype` member (`constructor`) is a key like any other.
    const byRole = new Map<string, string[]>();
    for (const entry of value) {
      const input = objectOf(entry);
      const role = stringOf(input["role"], "inputs[].role");
      const refs = byRole.get(role) ?? [];
      refs.push(stringOf(input["ref"], "inputs[].ref"));
      byRole.set(role, refs);
    }
    return Object.fromEntries(byRole);
  }

  /**
   * @param id - an asset ID.
   * @returns the store's entry of the asset, or null when the store does not hold it.
   */
  private assetOrNull(id: AssetId): WireAsset | null {
    const store = this.project.assets();
    if (!store.has(id)) return null;
    const { mime, name } = store.get(id);
    return { id, mime, name, url: store.url(id) };
  }

  /**
   * @param projectId - the project.
   * @param inputs - the request inputs.
   * @returns whether an input names the output of a record that has not finished.
   */
  private waitsForProducer(projectId: ProjectId, inputs: RunRequest["inputs"]): boolean {
    return inputs.some(
      (input) =>
        "record" in input.ref &&
        this.project.getRecord(projectId, input.ref.record).status !== "done",
    );
  }
}
