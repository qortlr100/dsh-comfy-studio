/**
 * Shared fixtures of the `@cs/project` unit tests: a temporary store root, record origins, in-memory asset stores,
 * a module set wired the same way as the `csProject` service, without a Cordis context, and the `test_library` slice
 * that the test reference kinds answer `createdBy` and `assetsOf` from.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { onTestFinished } from "vitest";
import { History } from "../history.ts";
import { RecordStore, type RecordLineInput } from "../record-store.ts";
import { ProjectError } from "../shared.ts";
import { projReducer, ReducerRegistry } from "../reducers.ts";
import { Runner, type RunnerAssets } from "../runner.ts";
import { Scheduler } from "../scheduler.ts";
import { Subscriptions } from "../subscriptions.ts";
import type {
  AssetId,
  AssetStore,
  ProjectEvent,
  ProjectId,
  ProjectInfo,
  RecordId,
  RecordOrigin,
  ReferenceKindSpec,
  SessionId,
  TurnId,
} from "../types.ts";

declare module "@cs/project" {
  interface ComponentStates {
    /**
     * The slice of the test reducers that stand in for the reference noun plugins: the assets and the creating record
     * of each version, by {@link versionKey}.
     */
    test_library?: { assets: Record<string, AssetId[]>; creators: Record<string, RecordId> };
  }
  /** The test reference kinds that the tests name in version references, with `string` IDs; they answer from `test_library`. */
  interface ReferenceKinds {
    test_character: string;
    test_location: string;
    test_style: string;
  }
}

/**
 * The `test_library` key of one version.
 * @returns `<kind>:<id>@<version>`.
 */
export function versionKey(kind: string, id: string, version: number): string {
  return `${kind}:${id}@${version}`;
}

/**
 * A reference kind that answers from the `test_library` slice.
 * @param kind - the kind, such as `test_character`.
 * @returns the spec.
 */
export function testKind(kind: string): ReferenceKindSpec<"test_library"> {
  return {
    kind,
    component: "test_library",
    assetsOf: (slice, id, version) => slice?.assets[versionKey(kind, id, version)] ?? null,
    createdBy: (slice, id, version) => slice?.creators[versionKey(kind, id, version)] ?? null,
    latest(slice, id) {
      let version = 0;
      while (slice?.creators[versionKey(kind, id, version + 1)] !== undefined) version += 1;
      return version === 0 ? null : version;
    },
  };
}

/**
 * A temporary directory that is removed when the current test finishes.
 * @returns the directory path.
 */
export function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cs-project-test-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The session most tests use. */
export const SESSION = brandString<SessionId>("session-a");
/** A second session, for tests with two chat sessions. */
export const OTHER_SESSION = brandString<SessionId>("session-b");

/**
 * A human edit from the app in {@link SESSION}.
 * @param overrides - fields to change.
 * @returns the origin.
 */
export function userOrigin(overrides: Partial<RecordOrigin> = {}): RecordOrigin {
  return {
    actor: "user",
    surface: "view",
    session: SESSION,
    turn: null,
    tool_call: null,
    intent: "edit in the app",
    ...overrides,
  };
}

/**
 * An agent tool call in {@link SESSION}.
 * @param turn - the turn ID text.
 * @param overrides - fields to change.
 * @returns the origin.
 */
export function agentOrigin(turn = "turn-1", overrides: Partial<RecordOrigin> = {}): RecordOrigin {
  return {
    actor: "agent",
    surface: "chat",
    session: SESSION,
    turn: brandString<TurnId>(turn),
    tool_call: `call-${turn}`,
    intent: "agent step",
    ...overrides,
  };
}

/** An in-memory asset store; IDs are the sha256 of the bytes, or of the path text for a path source. */
export class FakeAssets implements RunnerAssets {
  /** Asset ID → the record that created it. */
  readonly created = new Map<AssetId, string | null>();

  /**
   * Add an asset as if it had been imported earlier.
   * @param text - the asset's content.
   * @returns the asset ID.
   */
  add(text: string): AssetId {
    const id = brandString<AssetId>(createHash("sha256").update(text).digest("hex"));
    this.created.set(id, null);
    return id;
  }

  has(asset: AssetId): boolean {
    return this.created.has(asset);
  }

  importAsset(
    _project: ProjectId,
    source: Uint8Array | { path: string },
    _meta: { mime: string; name: string },
    createdBy: string | null,
  ): AssetId {
    const bytes = "path" in source ? Buffer.from(source.path) : source;
    const id = brandString<AssetId>(createHash("sha256").update(bytes).digest("hex"));
    this.created.set(id, createdBy);
    return id;
  }
}

/** An in-memory asset store with media types. */
export class MemoryAssets implements AssetStore {
  readonly files = new Map<AssetId, { mime: string; name: string; bytes: Uint8Array }>();

  has(asset: AssetId): boolean {
    return this.files.has(asset);
  }

  get(asset: AssetId): { mime: string; name: string } {
    const file = this.files.get(asset);
    if (file === undefined) throw new Error(`unknown asset ${asset}`);
    return file;
  }

  read(asset: AssetId): Uint8Array {
    return this.files.get(asset)?.bytes ?? new Uint8Array();
  }

  importAsset(
    _project: ProjectId,
    source: Uint8Array | { path: string },
    meta: { mime: string; name: string },
  ): AssetId {
    const bytes = source instanceof Uint8Array ? source : Buffer.from(source.path);
    const id = brandString<AssetId>(createHash("sha256").update(bytes).digest("hex"));
    this.files.set(id, { mime: meta.mime, name: meta.name, bytes });
    return id;
  }

  url(asset: AssetId): string {
    return `https://assets.example/${asset}`;
  }
}

/**
 * The projects of a module set without a Workspace registry: project `<id>` lives in the folder `<root>/<id>`.
 */
export class TestFolders {
  private readonly projects = new Map<ProjectId, ProjectInfo>();

  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Make project `id` in `<root>/<id>` with its first record, as the service does.
   * @param store - the store that writes the first record.
   * @param id - the project ID.
   * @param first - the first record line.
   * @param title - the project title.
   * @returns the project.
   */
  create(
    store: RecordStore,
    id: ProjectId,
    first: RecordLineInput,
    title = `Title of ${id}`,
  ): ProjectInfo {
    const path = join(this.root, id);
    const info = this.add(id, title);
    store.createProject(id, join(path, ".comfy-studio"));
    store.append(id, first);
    return info;
  }

  /**
   * List the existing folder `<root>/<id>` as project `id`.
   * @param id - the project ID.
   * @param title - the project title.
   * @returns the project.
   */
  add(id: ProjectId, title = `Title of ${id}`): ProjectInfo {
    const info = {
      id,
      title,
      created_at: new Date(
        Date.parse("2026-01-01T00:00:00Z") + this.projects.size * 1000,
      ).toISOString(),
      path: join(this.root, id),
    };
    this.projects.set(id, info);
    return info;
  }

  /** Forget a project, as removing its Workspace does. */
  remove(id: ProjectId): void {
    this.projects.delete(id);
  }

  get(id: ProjectId): ProjectInfo {
    const info = this.projects.get(id);
    if (info === undefined) throw new ProjectError("unknown_project", `There is no project ${id}.`);
    return info;
  }

  list(): ProjectInfo[] {
    return [...this.projects.values()];
  }
}

/** Every module of the service, wired as `CsProject` wires them, plus the events the store emitted. */
export interface ProjectModules {
  root: string;
  folders: TestFolders;
  store: RecordStore;
  subscriptions: Subscriptions;
  reducers: ReducerRegistry;
  history: History;
  scheduler: Scheduler;
  runner: Runner;
  assets: FakeAssets;
  events: Array<{ project: ProjectId; event: ProjectEvent }>;
}

/** The component keys that the fake operations of the Project tests use. */
export const STAND_IN_COMPONENTS = ["asset", "library", "image", "batch", "inspect"];

/**
 * Build the module set on a temporary root, load it, and register the `proj` reducer.
 * @param limits - the scheduler limits; defaults to one `gpu` and four `cpu`.
 * @returns the modules.
 */
export function startModules(limits = { cpu: 4, gpu: 1 }): ProjectModules {
  const root = tempRoot();
  const folders = new TestFolders(root);
  const events: ProjectModules["events"] = [];
  const subscriptions = new Subscriptions();
  // Scheduler and store refer to each other through callbacks, read at call time.
  const holder: { scheduler: Scheduler | null; runner: Runner | null } = {
    scheduler: null,
    runner: null,
  };
  const store = new RecordStore(folders, (project, event) => {
    events.push({ project, event });
    subscriptions.emit(project, event);
    if (event.kind === "update" && ["done", "failed", "cancelled"].includes(event.record.status))
      holder.scheduler?.recordFinished(project);
  });
  const reducers = new ReducerRegistry(
    store,
    (record) => holder.runner?.isOutsideHistory(record) ?? false,
  );
  const history = new History(store);
  const assets = new FakeAssets();
  const scheduler = new Scheduler(
    store,
    (project, record) => {
      if (holder.runner === null) throw new Error("runner not built");
      return holder.runner.execute(project, record);
    },
    limits,
  );
  const runner = new Runner({ store, reducers, scheduler, assets });
  // The fake operations of these tests stand in for the components that plugins register.
  for (const key of STAND_IN_COMPONENTS) runner.registerComponent(key);
  holder.scheduler = scheduler;
  holder.runner = runner;
  reducers.register("proj", projReducer);
  onTestFinished(() => {
    scheduler.dispose();
  });
  return {
    root,
    folders,
    store,
    subscriptions,
    reducers,
    history,
    scheduler,
    runner,
    assets,
    events,
  };
}

/**
 * The lines of a project's `records.jsonl`, parsed.
 * @param root - the store root.
 * @param project - the project.
 * @returns one object per line.
 */
export function readLines(root: string, project: ProjectId): Array<Record<string, unknown>> {
  return readFileSync(join(root, project, ".comfy-studio", "records.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => standIn<Record<string, unknown>>(JSON.parse(line)));
}

/**
 * Create a project the way `CsProject.createProject` does: its folder with the first record, `proj.create`.
 * @param modules - the module set.
 * @param title - the project title.
 * @returns the project ID.
 */
export function createTestProject(
  modules: ProjectModules,
  title = "Test project",
): Promise<ProjectId> {
  const id = brandString<ProjectId>(`project-${String(modules.store.listProjects().length + 1)}`);
  modules.folders.create(
    modules.store,
    id,
    {
      parents: [],
      kind: "operation",
      component: "proj",
      operation: "proj.create",
      operation_version: "1",
      ...userOrigin({ session: null, intent: `create project ${title}` }),
      params: { title },
      inputs: [],
      outputs: [],
      based_on: null,
      supersedes: [],
      deterministic: true,
      status: "done",
    },
    title,
  );
  return Promise.resolve(id);
}

/**
 * Strip `undefined` and `null` from a value, failing loudly when the test's expectation does not hold.
 * @param value - the value that the test expects to be present.
 * @param what - what the value is, for the error message.
 * @returns the value.
 */
export function defined<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`Expected ${what} to be defined`);
  return value;
}

/**
 * Narrow a caught value to an error class.
 * @param value - the caught value.
 * @param type - the error class that the test expects.
 * @returns the value as an instance of `type`.
 */
export function asError<T extends Error>(value: unknown, type: new (...args: never[]) => T): T {
  if (!(value instanceof type))
    throw new Error(`Expected an instance of ${type.name}`, { cause: value });
  return value;
}

/**
 * Give a test value the type that a call site expects. Tests hand minimal stand-ins to DSH APIs (a `{ id }` object for
 * an agent or a session, an in-memory object for a DSH service) and read tool results whose JSON shape the test itself
 * produced; the cast is the point of a stand-in, so it lives here once.
 * @param value - the stand-in or the loosely typed value.
 * @param _witness - never passed; it names `T` a second time in the signature, which the lint rule on lone type
 *   parameters wants. Callers let `T` be inferred from the context or write it as a type argument.
 * @returns the same value, typed as `T`.
 */
export function standIn<T>(value: unknown, ..._witness: T[]): T {
  // The test builds the value so that it has the shape `T` names; nothing here can check that.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as T;
}
