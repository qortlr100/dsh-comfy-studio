/**
 * The Project component as the `csProject` Cordis service. Project owns the records of every project, the history
 * list with its current position, the operation runner and scheduler, the reducer registry, history queries, and
 * change subscriptions. Every change to a project's content goes through this service and is written as a record:
 * - operations of every component go through {@link CsProject.run}, the single change path;
 * - Project's own actions (`proj.*`) go through the methods named after them, which write `proj.*` records.
 * Reads (`getState`, `getRecord`, `listHistory`, `openProject`, `listProjects`) write no record.
 *
 * History, as in the History panel of an image editor. Each record is a step of the project's history list; the
 * current position is one step of it, and the project state is the state at that step. `undo`, `redo` and `moveTo`
 * only move the current position and write no record. A write follows the current position, so the steps that were
 * after it are discarded; a discarded step that has not finished is cancelled.
 *
 * Concurrency: one lock per project. A run holds it while it checks and appends its record and while it writes each
 * update line, and releases it while the operation executes. Moves and project creation hold it for their whole
 * duration.
 *
 * Projects. A project is a DSH Workspace whose folder holds `.comfy-studio/records.jsonl` (the `folders` module); the
 * project ID is the Workspace ID, and the title, creation time and folder are the Workspace's. A chat session's project
 * is the project whose folder is the session's working directory (`sessionProject`). Project registers, renames and
 * removes these Workspaces itself; removing a project never deletes a file.
 *
 * Agent tools. While the DSH `tools` registry is mounted, every registered operation also has its agent tool
 * `cs_<operation name with _>`, built by the `agent-tools` module. A tool call runs the operation as the agent on the
 * project of its chat session, in the session's DSH turn. Project also registers its own `cs_proj_*` tools (the
 * `proj-tools` module); `cs_proj_create` makes the session's folder a project, and the tools return the project
 * summary,
 * to which each component's reducer adds its fields through `Reducer.agentSummary`. While the DSH `systemPrompt`
 * service is mounted, Project's rules reach the agent as the `cs:project` prompt section (the `agent-context` module),
 * whose text is the same at every step. While the DSH `sessionProjections` service is mounted, the project's state
 * reaches the agent as the project state message and afterwards as project update messages appended to the
 * conversation (the `project-updates` module), folded from what the session's log shows the agent saw.
 *
 * The asset component registers itself with {@link CsProject.registerAssetStore}; until it does, a run that names an input
 * asset or imports an output fails.
 *
 * The internal modules (`folders`, `record-store`, `runner`, `scheduler`, `history`, `reducers`, `subscriptions`,
 * `sessions`, `agent-tools`, `proj-tools`, `agent-context`, `project-updates`) are private;
 * `CONTRACTS.md` in this package specifies each of them.
 *
 * @module @cs/project
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import { brandString } from "@deepseek-ai/dsh-brand";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { SessionId as ChatId } from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-workspace";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { PROMPT_SECTION, projectContext } from "./agent-context.ts";
import { AgentTools, parseInputRef, parseInputs, turnOf } from "./agent-tools.ts";
import { History } from "./history.ts";
import type { OperationSpec } from "./operation-types.ts";
import { canonicalPath, ProjectFolders } from "./folders.ts";
import { projTools, type ProjToolDeps } from "./proj-tools.ts";
import { registerProjectUpdates } from "./project-updates.ts";
import { RecordStore } from "./record-store.ts";
import { projReducer, ReducerRegistry } from "./reducers.ts";
import { Runner } from "./runner.ts";
import { Scheduler } from "./scheduler.ts";
import { ProjectError } from "./shared.ts";
import { Sessions } from "./sessions.ts";
import { Subscriptions } from "./subscriptions.ts";
import type {
  AssetId,
  AssetStore,
  ComponentStates,
  ProjectLine,
  HistoryEntry,
  HistoryQuery,
  OperationCheck,
  ProjectEvent,
  ProjectId,
  ProjectInfo,
  ProjectRecord,
  ProjectState,
  RecordId,
  RecordInputRef,
  RecordOrigin,
  Reducer,
  ReferenceKindSpec,
  RunRequest,
  RunResult,
  SessionId,
} from "./types.ts";

export * from "./types.ts";
export * from "./operation-types.ts";
export { ProjectError } from "./shared.ts";
export { promptAssets, replacePromptCitations } from "./citations.ts";
export {
  citationTarget,
  citedAsset,
  citedInput,
  elementCitationUri,
  formatCitation,
  formatInputRef,
  parsePromptCitations,
  versionRefOf,
  type PromptCitation,
} from "./grammar.ts";
export { sessionOf, toolNameOf, type OperationToolValue } from "./agent-tools.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The Project component: records, undo, operations, state and history. */
    csProject: CsProject;
  }
}

/** The keys that the other arms of a record input reference use (`{asset}`, `{record, output}`, `version`); no
 *  reference kind may take one. */
const RESERVED_KINDS = { asset: true, record: true, version: true };

/** The folder name of the default projects folder, in the home directory. */
export const DEFAULT_PROJECTS_FOLDER = "comfy-studio-projects";

/**
 * The asset store while no plugin has registered one: it holds no asset. A project then has no asset to name as an
 * input and no output to describe, so reads and summaries answer as for a project without assets; only an operation
 * that imports an output fails.
 */
const EMPTY_ASSET_STORE: AssetStore = {
  has: () => false,
  get(asset) {
    throw new ProjectError("unknown_asset", `There is no asset ${asset}.`);
  },
  read(asset) {
    throw new ProjectError("unknown_asset", `There is no asset ${asset}.`);
  },
  importAsset() {
    throw new Error(
      "No asset store is registered with csProject, so the project cannot hold assets yet.",
    );
  },
  url(asset) {
    throw new ProjectError("unknown_asset", `There is no asset ${asset}.`);
  },
};

/** `csProject` plugin configuration. */
export interface Config {
  /**
   * The projects folder, an absolute path that holds the folders of new projects (`CS_PROJECTS_FOLDER`); created
   * when missing. Unset, it is `<home>/comfy-studio-projects` ({@link DEFAULT_PROJECTS_FOLDER} in the home directory
   * of the account that runs DSH), apart from the DSH home, so resetting the DSH home never removes a project's files.
   */
  projectsFolder?: string;
  /** Scheduled records of `cpu` operations that may run at the same time. */
  cpuConcurrency: number;
  /** Scheduled records of `gpu` operations that may run at the same time. */
  gpuConcurrency: number;
  /** Order of the `cs:project` section in the system prompt; before the tool SDK section at 5000. */
  promptSectionOrder: number;
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  projectsFolder: z.string(),
  cpuConcurrency: z.number().default(4),
  gpuConcurrency: z.number().default(1),
  promptSectionOrder: z.number().default(4900),
});

/** The Project service. */
export default class CsProject extends Service {
  static Config = Config;
  static inject = ["workspaceRegistry"];

  private readonly subscriptions = new Subscriptions();
  private projectsFolder = "";
  private readonly folders: ProjectFolders;
  private readonly store: RecordStore;
  private readonly reducers: ReducerRegistry;
  private readonly history: History;
  private readonly runner: Runner;
  private readonly scheduler: Scheduler;
  private readonly sessions: Sessions;
  private readonly agentTools: AgentTools;
  private assetStore: AssetStore | null = null;
  /**
   * Registers one operation's agent tool while the DSH tool registry is mounted, else null; and the disposer of each
   * operation's tool by operation name.
   */
  private registerOperationTool: ((spec: OperationSpec) => () => void) | null = null;
  private readonly toolDisposers = new Map<string, () => void>();

  private readonly config: Config;

  constructor(ctx: Context, config: Config) {
    super(ctx, "csProject");
    this.config = config;

    this.folders = new ProjectFolders(
      ctx.workspaceRegistry,
      () => this.projectsFolder,
      async () =>
        [
          ...(ctx
            .get("sessions")
            ?.list()
            .map((session) => session.header) ?? []),
          ...((await ctx.get("sessionPersistence")?.list()) ?? []).map(
            (snapshot) => snapshot.header,
          ),
        ].filter((header) => header.origin !== "subagent"),
      (message) => {
        ctx.logger("csProject").warn(message);
      },
    );
    this.subscriptions.onListenerError = (error) => {
      ctx
        .logger("csProject")
        .warn(
          "a project subscriber threw: %s",
          error instanceof Error ? error.message : String(error),
        );
    };
    // Every change on disk reaches the subscribers; a finished record also lets the scheduler start its dependents.
    this.store = new RecordStore(this.folders, (project, event) => {
      this.subscriptions.emit(project, event);
      if (event.kind === "update" && ["done", "failed", "cancelled"].includes(event.record.status))
        this.scheduler.recordFinished(project);
    });
    // The runner, created below, knows which operations are settings outside the history; it is read at call time.
    this.reducers = new ReducerRegistry(this.store, (record) =>
      this.runner.isOutsideHistory(record),
    );
    this.history = new History(this.store);
    // The scheduler runs ready records through the runner, which is created next; the callback reads it at call time.
    this.scheduler = new Scheduler(
      this.store,
      (project, record) => this.runner.execute(project, record),
      {
        cpu: config.cpuConcurrency,
        gpu: config.gpuConcurrency,
      },
    );
    // The runner reaches the asset store through the registered store, read at call time.
    this.runner = new Runner({
      store: this.store,
      reducers: this.reducers,
      scheduler: this.scheduler,
      assets: {
        has: (asset) => this.currentAssetStore().has(asset),
        importAsset: (project, source, meta, createdBy) =>
          this.currentAssetStore().importAsset(project, source, meta, createdBy),
      },
    });
    this.sessions = new Sessions();
    this.agentTools = new AgentTools(ctx, {
      sessions: this.sessions,
      sessionProject: (session) => this.sessionProject(session),
      assets: () => this.currentAssetStore(),
      currentState: (project) => this.getState(project),
      listReferenceKinds: () => this.reducers.listReferenceKinds(),
      kindsWithVersion: (state, id, version) => this.reducers.kindsWithVersion(state, id, version),
      run: (request) => this.run(request),
      getRecord: (project, record) => this.getRecord(project, record),
      listHistory: (query) => this.listHistory(query),
    });
    this.runner.registerComponent("proj");
    this.reducers.register("proj", projReducer);
    // The project summary that the `cs_proj_*` tools return and the project state message shows.
    const projToolDeps: ProjToolDeps = {
      assets: () => this.currentAssetStore(),
      agentSummaries: (state: ProjectState, session) =>
        this.reducers.agentSummaries(state, this.currentAssetStore(), session),
      turnOf: (exec) => turnOf(ctx, exec),
      chatFolder: (session) => this.chatFolder(session),
    };
    // Every registered operation has its agent tool while the DSH tool registry is mounted.
    ctx.inject(["tools"], (child) => {
      // The registry stays in this closure: read through the service from another plugin, it would bind each tool to
      // that plugin's fiber, which may be unloading (a tool call check removed while its plugin unloads).
      const registry = child.tools;
      child.effect(() => {
        this.registerOperationTool = (spec) => registry.register(this.agentTools.define(spec));
        for (const spec of this.listOperations()) this.addTool(spec);
        return () => {
          for (const dispose of this.toolDisposers.values()) dispose();
          this.toolDisposers.clear();
          this.registerOperationTool = null;
        };
      }, "csProject operation tools");
      for (const definition of projTools(this, projToolDeps))
        child.effect(() => registry.register(definition), `csProject ${definition.name}`);
    });
    ctx.inject(["systemPrompt"], (child) => {
      child.effect(
        () =>
          child.systemPrompt.section({
            name: PROMPT_SECTION,
            order: config.promptSectionOrder,
            interpolate: false,
            text: () => projectContext(this),
          }),
        "csProject prompt section",
      );
    });
    ctx.inject(["sessionProjections"], (child) => {
      registerProjectUpdates(child, this, projToolDeps);
    });
    ctx.effect(
      () => () => {
        this.scheduler.dispose();
      },
      "csProject stop scheduling",
    );
    this.runner.recover().catch((error: unknown) => {
      ctx
        .logger("csProject")
        .warn(
          "could not end unfinished records: %s",
          error instanceof Error ? error.message : String(error),
        );
    });
  }

  protected [Service.init](): void {
    if (this.config.projectsFolder === undefined) {
      const unresolved =
        "csProject: the home directory does not resolve on this host, so new projects have no folder. " +
        "Set CS_PROJECTS_FOLDER (Config.projectsFolder) to the folder that holds them.";
      let home: string;
      try {
        home = homedir();
      } catch (error) {
        // Node throws when the account has neither HOME nor a user database entry.
        throw new Error(unresolved, { cause: error });
      }
      if (!isAbsolute(home)) throw new Error(unresolved);
      this.projectsFolder = join(home, DEFAULT_PROJECTS_FOLDER);
      return;
    }
    if (!isAbsolute(this.config.projectsFolder)) {
      throw new Error(
        `csProject: CS_PROJECTS_FOLDER (Config.projectsFolder) must be an absolute path: '${this.config.projectsFolder}'.`,
      );
    }
    this.projectsFolder = this.config.projectsFolder;
  }

  /**
   * Make an empty folder in the projects folder: `<name>`, else `<name> 2`, `<name> 3`, … Two calls never get one
   * folder.
   * @param name - the folder name; a path separator in it becomes `-`.
   * @returns the folder path. Throws `invalid_params` for a name that is empty, `.` or `..`.
   */
  newProjectFolder(name: string): Promise<string> {
    return this.folders.newFolder(name);
  }

  /**
   * Make a folder a project: register it as a DSH Workspace titled `title`, then write the project's first record,
   * `proj.create` with `params {title}`, on `main` with status `done`, into its `.comfy-studio/records.jsonl`, write the
   * title once more so the last Workspace change of the create follows the record, and attach every stored or live chat
   * session whose working directory is the folder. A folder that is a project already keeps its records, and a call
   * repeated after a crash finishes the work.
   * @param folder - an existing folder.
   * @param title - the project title.
   * @param origin - who creates it, from where.
   * @returns the project's metadata.
   */
  createProject(folder: string, title: string, origin: RecordOrigin): Promise<ProjectInfo> {
    return this.folders.create(folder, title, (project, dir) =>
      this.store.lock(project, () => {
        this.store.createProject(project, dir);
        this.store.append(project, {
          parents: [],
          kind: "operation",
          component: "proj",
          operation: "proj.create",
          operation_version: "1",
          ...origin,
          params: { title },
          inputs: [],
          outputs: [],
          based_on: null,
          supersedes: [],
          deterministic: true,
          status: "done",
        });
      }),
    );
  }

  /**
   * Open a project: check that it exists and return its metadata. Writes no record; the caller remembers which project
   * a session works on.
   * @param project - the project.
   * @returns its metadata; throws `unknown_project`.
   */
  openProject(project: ProjectId): ProjectInfo {
    return this.store.getProject(project);
  }

  /** @returns every project's metadata, oldest first. */
  listProjects(): ProjectInfo[] {
    return this.store.listProjects();
  }

  /**
   * Change a project's Workspace title to the trimmed title, or, when another project uses that title, to the title
   * with the smallest free ` N` suffix from 2. The folder keeps its name. Writes no record.
   * @param project - the project.
   * @param title - the wanted title.
   * @returns the metadata after the change; throws `invalid_params` for a title that is empty after trimming.
   */
  renameProject(project: ProjectId, title: string): Promise<ProjectInfo> {
    return this.folders.rename(project, title);
  }

  /**
   * Remove a project: unregister its Workspace and forget its records in memory. The folder, its `.comfy-studio/`
   * directory and the chat logs stay on disk. Writes no record.
   * @param project - the project.
   */
  async removeProject(project: ProjectId): Promise<void> {
    await this.folders.remove(project);
    await this.store.lock(project, () => {
      this.store.forget(project);
    });
  }

  /**
   * Run one operation call: the single change path for every component's operations. The record goes after the
   * project's current position (see the module comment). With `after`,
   * the call is scheduled and the result holds the `pending` record. A read-only operation writes no record and
   * returns its answer in `report`.
   * @param request - the call.
   * @returns the record in its final status (or `pending` when scheduled), its outputs and report. Rejects with
   *   `ProjectError` only when the call is refused before a record is written.
   */
  run(request: RunRequest): Promise<RunResult> {
    return this.runner.run(request);
  }

  /**
   * Check one operation call against every refusal of `run`, writing nothing. The answer is advisory: `run` checks
   * the call again under the project lock.
   * @param request - the call.
   * @returns the refusal sentence (empty when `run` would accept the call now).
   */
  check(request: RunRequest): Promise<OperationCheck> {
    return this.runner.check(request);
  }

  /**
   * Move the current position one step back. Writes no record. Rules in the history module.
   * @param project - the project.
   * @returns the last step and the current position afterwards. Throws `nothing_to_undo` at the first record.
   */
  undo(project: ProjectId): Promise<ProjectLine> {
    return this.store.lock(project, () => this.history.undo(project));
  }

  /**
   * Move the current position to a step of the history list, before or after it. Writes no record. Rules in the history
   * module.
   * @param project - the project.
   * @param to - a step of the history list.
   * @returns the last step and the current position afterwards. Throws `unknown_record`, or `invalid_params` for a
   *   discarded record.
   */
  moveTo(project: ProjectId, to: RecordId): Promise<ProjectLine> {
    return this.store.lock(project, () => this.history.moveTo(project, to));
  }

  /**
   * Move the current position one step forward, toward the last step. Writes no record.
   * @param project - the project.
   * @returns the last step and the current position afterwards. Throws `nothing_to_redo`.
   */
  redo(project: ProjectId): Promise<ProjectLine> {
    return this.store.lock(project, () => this.history.redo(project));
  }

  /**
   * @param project - the project.
   * @returns the last step of the history list and the current position. Throws `unknown_project`, or `invalid_params`
   *   before the first record.
   */
  line(project: ProjectId): ProjectLine {
    return this.store.requireLine(project);
  }

  /**
   * Accept a stale record's result: write a `proj.stale_accept` record with `params {record}` after the current position,
   * which removes the record's stale mark from then on.
   * @param project - the project.
   * @param record - a stale record.
   * @param origin - who accepts it.
   * @returns the `proj.stale_accept` record.
   */
  acceptStale(project: ProjectId, record: RecordId, origin: RecordOrigin): Promise<ProjectRecord> {
    return this.runner.acceptStale(project, record, origin);
  }

  /**
   * The project's current state: one slice per registered reducer, computed at the current position.
   * @param project - the project.
   * @returns the state. Throws `unknown_project`.
   */
  getState(project: ProjectId): ProjectState {
    return this.reducers.getState(project);
  }

  /**
   * @param project - the project.
   * @param record - a record ID.
   * @returns the record in its current form. Throws `unknown_record`.
   */
  getRecord(project: ProjectId, record: RecordId): ProjectRecord {
    return this.store.getRecord(project, record);
  }

  /**
   * Every record of a project in write order, discarded records included (a discarded import keeps its asset in the
   * asset store). A read: it writes no record.
   * @param project - the project.
   * @returns the records in their current form.
   */
  listRecords(project: ProjectId): ProjectRecord[] {
    return this.store.listRecords(project);
  }

  /**
   * List the steps of a project's history list, newest first, each with its place relative to the current position;
   * discarded records are not listed.
   * @param query - the project and the filters.
   * @returns the entries.
   */
  listHistory(query: HistoryQuery): HistoryEntry[] {
    return this.history.list(query);
  }

  /**
   * Wait until records finish.
   * @param project - the project.
   * @param records - the records to wait for; omitted means every scheduled record of the project.
   * @returns a promise that settles when they are `done`, `failed` or `cancelled`.
   */
  wait(project: ProjectId, records?: RecordId[]): Promise<void> {
    return this.scheduler.wait(project, records);
  }

  /**
   * Receive a project's record appends and record updates, after each is on disk.
   * @param project - the project.
   * @param listener - called synchronously for each change.
   * @returns a function that removes the listener.
   */
  subscribe(project: ProjectId, listener: (event: ProjectEvent) => void): () => void {
    return this.subscriptions.subscribe(project, listener);
  }

  /**
   * Register a component's key; a plugin calls it inside `ctx.effect` before it registers the component's reducer and
   * operations. The core keeps no list of components: every built-in and added plugin registers its own key in the same
   * way, and Project registers its own key `proj`.
   * @param key - the component key, such as `asset`.
   * @returns a function that removes the key. Throws `component_exists`.
   */
  registerComponent(key: string): () => void {
    return this.runner.registerComponent(key);
  }

  /**
   * Register an operation and, while the DSH `tools` registry is mounted, its agent tool `cs_<name with _>`; a
   * component calls it from its plugin inside `ctx.effect` and returns the disposer.
   * @param spec - the operation.
   * @returns a function that removes the operation and its tool. Throws `operation_exists`, or `invalid_params` for an
   *   unregistered component key or a name that does not start with `<component>.`.
   */
  registerOperation(spec: OperationSpec): () => void {
    const remove = this.runner.registerOperation(spec);
    this.addTool(spec);
    return () => {
      remove();
      this.toolDisposers.get(spec.name)?.();
      this.toolDisposers.delete(spec.name);
    };
  }

  /** @returns every registered operation, in registration order. */
  listOperations(): OperationSpec[] {
    return this.runner.listOperations();
  }

  /**
   * Register a component's reducer for its state slice; a component calls it inside `ctx.effect`, after
   * `registerComponent`.
   * @param key - the component key, declared in `ComponentStates`.
   * @param reducer - the reducer.
   * @returns a function that removes it. Throws `reducer_exists`, or `invalid_params` for an unregistered component key.
   */
  registerReducer<K extends keyof ComponentStates>(key: K, reducer: Reducer<K>): () => void {
    if (!this.runner.hasComponent(key)) {
      throw new ProjectError(
        "invalid_params",
        `A reducer names the component '${key}', which no plugin registered.`,
      );
    }
    return this.reducers.register(key, reducer);
  }

  /**
   * Register a reference kind, whose versions inputs name as `<id>@<version>`; a plugin calls it inside `ctx.effect`,
   * after `registerComponent` of the owning key. Every operation tool is rebuilt, because its `inputs` text lists the
   * kinds.
   * @param spec - the kind and how its owner answers for one version.
   * @returns a function that removes the kind. Throws `kind_exists`, or `invalid_params` for an unregistered component key
   *   or the kind `asset`, `record` or `version`.
   */
  registerReferenceKind<K extends keyof ComponentStates>(spec: ReferenceKindSpec<K>): () => void {
    if (Object.hasOwn(RESERVED_KINDS, spec.kind)) {
      throw new ProjectError(
        "invalid_params",
        `Reference kind ${spec.kind} is reserved: an input reference uses that key itself.`,
      );
    }
    if (!this.runner.hasComponent(spec.component)) {
      const message = `Reference kind ${spec.kind} names the component '${spec.component}', which no plugin registered.`;
      throw new ProjectError("invalid_params", message);
    }
    const remove = this.reducers.registerKind(spec);
    this.refreshTools();
    return () => {
      remove();
      this.refreshTools();
    };
  }

  /** @returns the registered reference kinds in registration order, for agent text. */
  listReferenceKinds(): readonly string[] {
    return this.reducers.listReferenceKinds();
  }

  /**
   * The reference kinds that have an ID. IDs are unique across kinds: a kind owner's create refuses an ID that this
   * lists.
   * @param state - the state to look in, normally the state at the create's parent.
   * @param id - the ID, such as `p1`.
   * @returns the kinds whose `latest` knows the ID, in registration order.
   */
  kindsWithId(state: ProjectState, id: string): readonly string[] {
    return this.reducers.kindsWithId(state, id);
  }

  /**
   * The newest version of an ID in one reference kind, from the kind's `latest`.
   * @param state - the state to look in, normally the project's current state.
   * @param kind - a reference kind.
   * @param id - the ID.
   * @returns the version, or null for an unknown ID or a kind that is not registered.
   */
  latestVersion(state: ProjectState, kind: string, id: string): number | null {
    return this.reducers.latestVersion(state, kind, id);
  }

  /**
   * Parse one reference text: `<record>#<n>` names output n of a record, `<id>@<n>` version n of the one reference
   * kind that has it, anything else an asset.
   * @param text - the reference text.
   * @param state - the state the version is looked up in, normally the project's current state.
   * @returns the reference. Throws `invalid_inputs` for a version that no kind, or more than one kind, has.
   */
  parseReference(text: string, state: ProjectState): RecordInputRef {
    return parseInputRef(text, state, this.reducers);
  }

  /**
   * The assets a version stands for, read through `assetsOf` of its reference kind.
   * @param state - the state to read the version in, normally the project's current state.
   * @param ref - a versioned input reference.
   * @returns the version's assets, or null for an unknown version or a kind that is not registered.
   */
  assetsOf(state: ProjectState, ref: RecordInputRef): AssetId[] | null {
    return this.reducers.assetsOf(state, ref);
  }

  /**
   * Turn the `inputs` argument of a tool call or a view request into run inputs: `<record>#<n>` names output n of a
   * record, `<id>@<n>` a version of a reference kind, anything else an asset.
   * @param operation - a registered operation name.
   * @param raw - role → reference text or a list of them; undefined for none.
   * @param state - the state the references are read against, normally the project's current state.
   * @param callerName - the name the error messages give the call: the tool name for an agent tool call, the operation
   *   name (the default) for a view request or a call made by another operation.
   * @returns the inputs. Throws `unknown_operation`, or an `Error` naming the role and `callerName` for an unknown role,
   *   a list on a single role, or a missing required role, or `invalid_inputs` for an unknown or ambiguous version.
   */
  parseInputs(
    operation: string,
    raw: unknown,
    state: ProjectState,
    callerName: string = operation,
  ): RunRequest["inputs"] {
    const spec = this.listOperations().find((candidate) => candidate.name === operation);
    if (spec === undefined)
      throw new ProjectError("unknown_operation", `Operation ${operation} is not registered.`);
    return parseInputs(spec, raw, state, this.reducers, callerName);
  }

  /**
   * @param session - a chat session.
   * @returns the project whose folder is the session's working directory, or null when it has none.
   */
  sessionProject(session: SessionId): ProjectId | null {
    return this.folders.ofFolder(this.chatFolder(session) ?? undefined);
  }

  /**
   * Make the session's next agent tool calls wait until `work` settles, for example while the images of the human's
   * message are imported. A failure of `work` does not fail the calls.
   * @param session - the chat session.
   * @param work - the work.
   */
  holdToolCalls(session: SessionId, work: Promise<unknown>): void {
    this.sessions.hold(session, work);
  }

  /**
   * Register the asset store; one at a time, a later registration replaces the earlier one.
   * @param store - the store.
   * @returns a function that removes it.
   */
  registerAssetStore(store: AssetStore): () => void {
    this.assetStore = store;
    return () => {
      if (this.assetStore === store) this.assetStore = null;
    };
  }

  /**
   * The asset store that reads go through, for callers outside the project layer such as the view API.
   * @returns the registered asset store, or one that holds no asset while no plugin has registered one.
   */
  assets(): AssetStore {
    return this.currentAssetStore();
  }

  /** @returns the registered asset store, or {@link EMPTY_ASSET_STORE} while no plugin has registered one. */
  private currentAssetStore(): AssetStore {
    return this.assetStore ?? EMPTY_ASSET_STORE;
  }

  /**
   * @param session - a chat session.
   * @returns the canonical working directory of the live session, or null when it is not live or records none.
   */
  private chatFolder(session: SessionId): string | null {
    const cwd = this.ctx.get("sessions")?.get(brandString<ChatId>(session))?.header.cwd;
    return (cwd === undefined ? undefined : canonicalPath(cwd)) ?? null;
  }

  /** Register the agent tool of an operation while the DSH tool registry is mounted. */
  private addTool(spec: OperationSpec): void {
    if (this.registerOperationTool === null) return;
    this.toolDisposers.set(spec.name, this.registerOperationTool(spec));
  }

  /** Rebuild the agent tool of every operation, whose `inputs` text lists the registered reference kinds. */
  private refreshTools(): void {
    for (const spec of this.listOperations()) {
      this.toolDisposers.get(spec.name)?.();
      this.addTool(spec);
    }
  }
}
