/**
 * Types of the Project component: IDs, the record format of `records.jsonl`, operations, reducers, project state,
 * history queries, and run requests.
 *
 * Field case: types that are written to disk or sent over the wire (records, update lines, project metadata, run
 * requests, history queries) use snake_case fields, matching the record format. Types that only
 * code sees (operation specs, the execute context, reducers) use camelCase members.
 *
 * This file is the client face `@cs/project/types`: it imports no host module, so the browser program can read it.
 * `OperationSpec` and `OperationToolCall` use DSH tool types and live in `operation-types.ts`.
 *
 * @module @cs/project/types
 */
import type { Branded } from "@deepseek-ai/dsh-brand";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

/**
 * The ID of an asset: the SHA-256 hex digest of its bytes. Project defines it because records name assets; the asset
 * pool depends on Project and re-exports it.
 */
export type AssetId = Branded<"CsAssetId">;

/** The ID of a project: the ID of the project's DSH Workspace. */
export type ProjectId = Branded<"CsProjectId">;

/** The ID of one record in a project's `records.jsonl`. */
export type RecordId = Branded<"CsRecordId">;

/**
 * The ID of one agent turn: one run of the agent from a request to its reply. It is the DSH turn number of the chat
 * session as a string (`"3"`), unique within the session; Project reads it when an agent tool runs.
 */
export type TurnId = Branded<"CsTurnId">;

/** The ID of one chat session; the DSH session ID of the agent that the human talks to. */
export type SessionId = Branded<"CsSessionId">;

/** What a record represents: one call of one operation. */
export type RecordKind = "operation";

/** Who caused a record. `system` is used only for automatic actions, such as a scheduled render. */
export type Actor = "user" | "agent" | "system";

/** Where the action that caused a record came from. */
export type Surface = "chat" | "canvas" | "timeline" | "asset_pool" | "api" | "history";

/**
 * The state of an operation call. It only moves forward: `pending` → `running` → `done` | `failed` | `cancelled`;
 * `pending` may also move straight to `done` (reused outputs), `failed` or `cancelled`.
 */
export type RecordStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/**
 * Reference kinds by stored key, each with the type of its IDs. The plugin that owns a kind adds it by declaration
 * merging and registers it with `csProject.registerReferenceKind`; Project declares none.
 */
export interface ReferenceKinds {}

/** The stored key of each declared reference kind. */
type KindKey = Extract<keyof ReferenceKinds, string>;

/** Kind → its version reference arm: the kind's key with the ID, and `version`. One object type per arm, with zero or
 *  more kinds declared, keeps the union free of redundant members. */
type VersionArms = {
  [K in KindKey]: { [P in K | "version"]: P extends "version" ? number : ReferenceKinds[K] };
};

/** Every arm of a record input reference by name: the version arms, an asset, and the n-th output of a record. */
interface InputRefArms extends VersionArms {
  asset: { asset: AssetId };
  record: { record: RecordId; output: number };
}

/** What one record input refers to, such as `{prop: 'p1', version: 2}`: an asset, the n-th output of an earlier record,
 *  or one version of a reference kind. The disk format does not change. */
export type RecordInputRef = InputRefArms[keyof InputRefArms];

/** One version reference, such as `{prop: 'p1', version: 2}`: a reference kind's key with the ID, and the version. */
export type VersionRef = VersionArms[KindKey];

/** How the owner of a reference kind answers for one version; `csProject.registerReferenceKind` takes it. */
export interface ReferenceKindSpec<K extends keyof ComponentStates = keyof ComponentStates> {
  /** The stored key and the agent noun, such as `prop`. Never `asset`, `record` or `version`. */
  kind: string;
  /** The owning component key; registered before the kind. */
  component: K;
  /** @returns the assets of the version, or null for an unknown version. */
  assetsOf(slice: ComponentStates[K], id: string, version: number): AssetId[] | null;
  /** @returns the record that wrote the version (its producer for stale marks), or null for an unknown version. */
  createdBy(slice: ComponentStates[K], id: string, version: number): RecordId | null;
  /** @returns the newest version of the ID, or null when the kind has no such ID. */
  latest(slice: ComponentStates[K], id: string): number | null;
}

/** One input of a record: what the operation read. */
export interface RecordInput {
  /** The input's role, one of the operation's `inputRoles`, for example `reference`. */
  role: string;
  ref: RecordInputRef;
  /**
   * The asset the input stood for when the operation ran. Null on the record line for a `{record, output}` ref whose
   * producer had not finished when the record was written; the record store fills it in the current form of the
   * record once the producer is done.
   */
  resolved_asset: AssetId | null;
}

/** The cost of one operation call, written by its final update line. */
export interface RecordCost {
  wall_seconds: number;
  /** Whether the outputs were reused from an earlier identical deterministic call instead of executed. */
  reused: boolean;
}

/**
 * Why a call failed or was cancelled, in words a creator can read. `code` is one of `operation_failed` (the
 * operation's execute threw), `input_failed` (a record the scheduled call waited for failed), or `stopped` (the turn
 * was stopped: the run request's signal aborted). A stopped record ends with status `cancelled`.
 */
export interface RecordFailure {
  code: string;
  message: string;
}

/** The record whose execute started a call, the position that the caller gave the call in its own sequence (or null),
 *  and the caller's parallel sequence, such as a variant. The kernel stores it and never reads it. */
export interface StartedBy {
  record: RecordId;
  slot: number | null;
  lane?: string;
}

/**
 * One record of a project, in its current form: the fields of the record line, plus the fields that its update lines
 * set. The record line on disk carries only the fields up to `created_at`; `started_at`, `finished_at`, `error`,
 * `cost` and `report` appear only after an update line sets them.
 */
export interface ProjectRecord {
  id: RecordId;
  /** The record written just before this one; empty only for the first record of a project. */
  parents: RecordId[];
  kind: RecordKind;
  /** The component key that owns the operation, for example `timeline`. */
  component: string;
  /** The operation name, for example `timeline.clip_move`. */
  operation: string | null;
  /** The version of the operation's parameter schema. */
  operation_version: string | null;
  actor: Actor;
  surface: Surface;
  /** The agent turn that made the record; null for direct human actions. */
  turn: TurnId | null;
  /** The chat session of the turn, or of the human's edit; null when the action has no chat session. */
  session: SessionId | null;
  /** The agent's tool-call ID that made the record; null when the human acted directly. */
  tool_call: string | null;
  /** Why: the agent's `reason` argument, or a short description of the human's gesture, such as "move clip 3 before clip 1". */
  intent: string;
  /** The operation's parameters, valid against its schema. The owning component defines their meaning. */
  params: Record<string, unknown>;
  inputs: RecordInput[];
  /** Assets the operation created; empty for operations that only change data. */
  outputs: AssetId[];
  /** The record this one repeats with changes, such as a new take with an edited prompt. */
  based_on: RecordId | null;
  /** Records whose outputs this one replaces; their dependents become stale. */
  supersedes: RecordId[];
  /** The record that started this call, copied from the run request; absent when no record started it. */
  started_by?: StartedBy;
  /** Whether the same inputs and parameters always give the same outputs, which allows reuse. */
  deterministic: boolean;
  status: RecordStatus;
  /** When the record was written, ISO-8601 UTC. */
  created_at: string;
  /** When the call started running, ISO-8601 UTC; set by an update line. */
  started_at?: string;
  /** When the call ended, ISO-8601 UTC; set by an update line. */
  finished_at?: string;
  /** Why the call failed or was cancelled; set by an update line. */
  error?: RecordFailure;
  /** Set by the final update line of an executed call. */
  cost?: RecordCost;
  /** Facts the operation found besides its outputs, such as the seed it drew; set by an update line. */
  report?: Record<string, unknown>;
}

/**
 * One update line of `records.jsonl`: `{"update": "<RecordId>", …}` with the fields that changed. Only these fields
 * may change, only while the record is not finished, and `status` only moves forward.
 */
export interface RecordUpdate {
  update: RecordId;
  status?: RecordStatus;
  started_at?: string;
  finished_at?: string;
  outputs?: AssetId[];
  error?: RecordFailure;
  cost?: RecordCost;
  report?: Record<string, unknown>;
}

/**
 * Who caused an action, from where, and why: the fields every record copies from the call that wrote it. Run requests
 * and the `proj.*` service methods take it.
 */
export interface RecordOrigin {
  actor: Actor;
  surface: Surface;
  /** The chat session the action belongs to; null for an action outside any chat session. */
  session: SessionId | null;
  /** The agent turn; null for direct human actions. */
  turn: TurnId | null;
  /** The agent's tool-call ID; null when the human acted directly. */
  tool_call: string | null;
  intent: string;
}

/** A project's metadata, read from its DSH Workspace. */
export interface ProjectInfo {
  id: ProjectId;
  /** The Workspace title. */
  title: string;
  /** When the Workspace was registered, ISO-8601 UTC. */
  created_at: string;
  /** The canonical path of the project folder; its `.comfy-studio/` directory holds the DreamVerse files. */
  path: string;
}

/** The result of an operation's execute function. */
export interface OperationResult {
  /** The created assets, in the order the operation declares them. */
  outputs: AssetId[];
  /** Facts besides the outputs, such as the seed a renderer drew; a read returns its answer here. */
  report?: Record<string, unknown>;
}

/** What an operation's execute function receives. */
export interface OperationContext {
  project: ProjectId;
  /** The running record; null for a read-only operation, which writes no record. */
  record: ProjectRecord | null;
  params: Record<string, unknown>;
  /** The record's inputs; every `resolved_asset` is set. */
  inputs: RecordInput[];
  /** The project state at the record's parent (for a read, the project's current state). */
  state: ProjectState;
  /** A directory the call may write temporary files into; the runner removes it after the call. */
  scratchDir: string;
  /** Aborted when the caller's run request aborts. */
  signal: AbortSignal;
  /**
   * Import a file or bytes the operation produced into the asset pool, in the project's folder, as an asset created by
   * this record.
   * @param source - the bytes, or a file path to copy.
   * @param meta - the asset's media type, display name, duration for audio and video, and pixel width and height of
   *   images and video when the operation knows them.
   * @returns the asset's ID.
   */
  importAsset(
    source: Uint8Array | { path: string },
    meta: { mime: string; name: string; durationSec?: number; width?: number; height?: number },
  ): AssetId;
}

/** The kind of file or value an operation input or output carries. */
type OperationValueType = "image" | "video" | "audio" | "text" | "json" | "any";

/** One input role of an operation, as the agent tool and the canvas form declare it. */
export interface OperationInput {
  type: OperationValueType;
  description: string;
  required?: boolean;
  /** Whether the role takes several references, such as every reference image of a shot. */
  many?: boolean;
  /** Whether the role also accepts versions of the registered reference kinds (`<id>@<version>`) besides assets. */
  versioned?: boolean;
}

/** One output of an operation, in the order its `execute` returns them. */
export interface OperationOutput {
  role: string;
  type: OperationValueType;
}

/**
 * The state slice of each component, keyed by component key. Each component adds its slice by declaration merging:
 *
 * ```ts
 * declare module '@cs/project/types' {
 *   interface ComponentStates { timeline: TimelineState }
 * }
 * ```
 *
 * Project declares its own slice, `proj`.
 */
export interface ComponentStates {
  proj: {
    /** The records of the history list up to the current position, oldest first. */
    records: ProjectRecord[];
    /** Stale records: record → the record whose change made it stale. */
    stale: Record<RecordId, RecordId>;
    /** Superseded records: record → the record that superseded it. */
    superseded: Record<RecordId, RecordId>;
    /** The record that created each output asset. */
    created_by: Record<AssetId, RecordId>;
  };
}

/** A component key that has a declared state slice. */
type ComponentKey = keyof ComponentStates;

/**
 * A component's reducer: it turns the records up to the current position into the component's state slice. Reducers are pure: they
 * read only their arguments and return a new slice or the same slice unchanged.
 */
export interface Reducer<K extends ComponentKey = ComponentKey> {
  /**
   * @returns the slice before any record.
   */
  initial(): ComponentStates[K];
  /**
   * Apply one record. The reducer receives every record of the chain, of every component, in order, then every record
   * of its own component's `outsideHistory` operations in write order, and ignores the records it does not interpret.
   * @param slice - the slice before the record.
   * @param record - the record in its current form.
   * @returns the slice after the record.
   */
  reduce(slice: ComponentStates[K], record: ProjectRecord): ComponentStates[K];
  /**
   * The fields of this slice that the agent reads in the project summary that `cs_proj_state` and the other
   * `cs_proj_*` tools return. Project merges the fields of every reducer that defines it after the record count and
   * before the stale records, Project's `proj` slice first and then the other components in the alphabetical order of
   * their keys; a field name that Project or another component already uses throws `invalid_params`.
   * @param slice - the slice of the current state.
   * @param assets - the asset store, for the URLs of the assets the slice names.
   * @param state - the whole current state, for the records the slice refers to.
   * @param session - the session whose agent reads the summary, for fields that differ per conversation.
   * @returns the fields by name.
   */
  agentSummary?(
    slice: ComponentStates[K],
    assets: Pick<AssetStore, "url">,
    state: ProjectState,
    session: SessionId,
  ): Record<string, JsonValue>;
}

/** The state of a project at one record: the result of the chain that ends there. */
export interface ProjectState {
  project: ProjectInfo;
  /** The record the state is computed at; for the current state, the current position. */
  head: RecordId;
  /** One slice per registered reducer. */
  components: ComponentStates;
}

/** What a history query selects. Every filter is optional; filters combine with AND. */
export interface HistoryQuery {
  project: ProjectId;
  actor?: Actor;
  component?: string;
  operation?: string;
  kind?: RecordKind;
  status?: RecordStatus;
  session?: SessionId;
  turn?: TurnId;
  /** Only records written by this tool call. */
  tool_call?: string;
  /** Only these records. */
  records?: RecordId[];
  /** Only records written before this record, for paging. */
  before?: RecordId;
  /** At most this many entries. */
  limit?: number;
}

/** One entry of the history list: one step and where it stands relative to the current position. */
export interface HistoryEntry {
  record: ProjectRecord;
  /** `current` for the current position, `before` for a step before it, `after` for a step redo brings back. */
  place: "before" | "current" | "after";
}

/** One operation call through `csProject.run`. */
export interface RunRequest extends RecordOrigin {
  project: ProjectId;
  /** The operation name. */
  operation: string;
  params: Record<string, unknown>;
  inputs: Array<{ role: string; ref: RecordInputRef }>;
  /**
   * Schedule the call instead of running it now: the runner writes the pending record at once and the scheduler runs
   * it after these records and the producers of its `{record, output}` inputs are done.
   */
  after?: RecordId[];
  based_on?: RecordId | null;
  supersedes?: RecordId[];
  /** The record whose execute makes this call, with the slot and lane it gives the call; copied onto the record. */
  started_by?: StartedBy;
  /** The turn's stop signal: aborting it aborts the execution (code `stopped`). */
  signal?: AbortSignal;
}

/** What `csProject.run` returns. */
export interface RunResult {
  /** The record in its final status; pending for a scheduled call; null for a read. */
  record: ProjectRecord | null;
  outputs: AssetId[];
  report: Record<string, unknown> | null;
}

/** What `csProject.check` returns: whether `run` would accept a call on the current state. */
export interface OperationCheck {
  /** The sentence of the first refusal, verbatim; empty when the call can run. */
  problems: string[];
}

/** The history list's last step and the current position, as `line.json` stores them. */
export interface ProjectLine {
  /** The last step of the history list; the list is its `parents[0]` ancestry. */
  tip: RecordId;
  /** The current position: a record of the history list; the project state is the state at it. */
  at: RecordId;
}

/**
 * What one logged project message or DreamVerse tool result showed a chat session's agent of one project. Written to
 * the DSH session log inside the source of a project message, and as `cs_seen` inside the persisted metadata of a tool
 * result (`tool/result.meta`), which the model never reads. A project update lists what the session's entries have not
 * shown.
 */
export type ProjectShown =
  /** A project update message or a tool result: each record listed, in the status listed, and the position if shown. */
  | {
      project: ProjectId;
      records: Partial<Record<RecordId, RecordStatus>>;
      at?: RecordId | undefined;
      base?: undefined;
    }
  /**
   * The project state message: records `[0, base)` in write order count as shown in a final status, except the
   * unfinished ones, which `records` lists in their status.
   */
  | {
      project: ProjectId;
      records: Partial<Record<RecordId, RecordStatus>>;
      at: RecordId;
      base: number;
    };

/** What a subscriber learns about a project change. */
export type ProjectEvent =
  | { kind: "record"; record: ProjectRecord }
  | { kind: "update"; record: ProjectRecord }
  /** The current position or the last step changed (an append, undo, redo, or a move to a step). */
  | ({ kind: "line" } & ProjectLine);

/**
 * The asset pool as Project sees it: Project checks that input assets exist, imports the files operations produce,
 * and describes outputs to the agent. The asset pool registers itself with `csProject.registerAssetStore`.
 */
export interface AssetStore {
  /**
   * @param asset - an asset ID.
   * @returns whether the asset pool holds it.
   */
  has(asset: AssetId): boolean;
  /**
   * @param asset - an asset the pool holds.
   * @returns its media type and display name. Throws for an unknown asset.
   */
  get(asset: AssetId): { mime: string; name: string };
  /**
   * @param asset - an asset the pool holds.
   * @returns its bytes. Throws for an unknown asset.
   */
  read(asset: AssetId): Uint8Array;
  /**
   * Import a file or bytes into the asset pool, in the project's folder.
   * @param project - the project whose folder receives the bytes.
   * @param source - the bytes, or a file path to copy.
   * @param meta - the media type, the display name, the duration for audio and video, and the pixel size when known.
   * @param createdBy - the record that created the asset; null for a read-only operation.
   * @returns the asset's ID; throws `unknown_project`.
   */
  importAsset(
    project: ProjectId,
    source: Parameters<OperationContext["importAsset"]>[0],
    meta: Parameters<OperationContext["importAsset"]>[1],
    createdBy: RecordId | null,
  ): AssetId;
  /**
   * @param asset - an asset ID.
   * @returns the URL that serves its bytes, as the agent and chat cards show it.
   */
  url(asset: AssetId): string;
}
