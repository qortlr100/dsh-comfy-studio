/**
 * A mounted project layer for the tests of the asset operations: the real runner, reducer registry and history over
 * temporary folders, with the asset operations and reducer registered on top of a fake store.
 */
import { basename } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import type {
  AssetId,
  OperationSpec,
  ProjectId,
  ProjectRecord,
  RecordId,
  RunRequest,
  RunResult,
} from "@cs/project";
import {
  agentOrigin,
  createTestProject,
  defined,
  standIn,
  startModules,
  userOrigin,
} from "@cs/project/testing/support";
import { assetOperations } from "../operations.ts";
import { assetReducer } from "../reducer.ts";
import type { AssetListReport, AssetSlice } from "../types.ts";
import { fakeStore, storedAsset } from "./library.ts";

/** What a test says about one call beyond the operation and its params. */
export interface CallOptions {
  /** The assets of the input role. */
  assets?: AssetId[];
  /** The input role; `asset` by default. */
  role?: string;
  /** Call as an agent in a chat turn instead of as the user. */
  agent?: boolean;
}

/** One file the fake host was asked to import. */
export interface ImportedFile {
  path: string;
  mime: string;
  name: string;
}

/**
 * Mount the project layer with the asset component and one project.
 * @returns the handle the tests drive.
 */
export async function mount() {
  const m = startModules();
  const project: ProjectId = await createTestProject(m);
  const store = fakeStore();
  const imports: ImportedFile[] = [];

  // The store's import of a path gives back the asset that the path names, as the real store would by its bytes.
  m.assets.importAsset = (_project, source, meta, createdBy) => {
    if (source instanceof Uint8Array) throw new Error("The test store imports paths only.");
    imports.push({ path: source.path, mime: meta.mime, name: meta.name });
    const id = brandString<AssetId>(basename(source.path));
    m.assets.created.set(id, createdBy);
    return id;
  };

  const operations = assetOperations(store);
  m.reducers.register("asset", assetReducer);
  for (const spec of operations) m.runner.registerOperation(spec);
  // A stand-in generation operation of another component: its output enters the library as pending.
  const generate: OperationSpec = {
    name: "image.make",
    component: "image",
    version: "1",
    description: "Make an image.",
    params: { name: { type: "string", required: true } },
    inputs: {},
    outputs: [{ role: "image", type: "image" }],
    deterministic: false,
    resource: "none",
    summarize: () => "made an image",
    execute: (call) => {
      const text = String(call.params["name"]);
      const id = m.assets.add(text);
      store.entries.set(id, storedAsset(id, `${text}.png`));
      return Promise.resolve({ outputs: [id] });
    },
  };
  m.runner.registerOperation(generate);
  const tools = new Map([["image.make", "cs_image_make"]]);
  store.toolOf = (operation) => tools.get(operation) ?? null;

  /** @returns the request for a call. */
  const requestOf = (operation: string, params: Record<string, unknown>, options: CallOptions) => ({
    project,
    operation,
    params,
    inputs: (options.assets ?? []).map((asset) => ({
      role: options.role ?? "asset",
      ref: { asset },
    })),
    ...(options.agent === true ? agentOrigin() : userOrigin()),
  });

  return {
    modules: m,
    project,
    operations,
    imports,
    defined,
    /** Put bytes into the store (not yet in the project's library) and get the asset's ID. */
    stored(name: string): AssetId {
      const id = m.assets.add(name);
      store.entries.set(id, storedAsset(id, `${name}.png`));
      return id;
    },
    /** An asset the project layer's store holds but the asset store has no entry for. */
    unlisted(name: string): AssetId {
      return m.assets.add(name);
    },
    /** An asset ID that neither the store nor the project layer knows. */
    loose(name: string): AssetId {
      return brandString<AssetId>(`loose-${name}`);
    },
    run(
      operation: string,
      params: Record<string, unknown> = {},
      options: CallOptions = {},
    ): Promise<RunResult> {
      return m.runner.run(requestOf(operation, params, options));
    },
    /** Run a call with the given fields over the defaults, for inputs that are not plain assets. */
    runRaw(request: Pick<RunRequest, "operation" | "params" | "inputs">): Promise<RunResult> {
      return m.runner.run({ project, ...userOrigin(), ...request });
    },
    propose(
      operation: string,
      params: Record<string, unknown> = {},
      options: CallOptions = {},
    ): Promise<ProjectRecord> {
      return m.runner.propose({ ...requestOf(operation, params, options), ...agentOrigin() });
    },
    /** Run the stand-in generation operation; its output enters the library as pending. */
    runGenerate(name: string): Promise<RunResult> {
      return m.runner.run(requestOf("image.make", { name }, {}));
    },
    library(): AssetSlice {
      return defined(m.reducers.getState(project).components.asset, "the asset slice");
    },
    /** The operations of the history list, newest first. */
    history(): Array<string | null> {
      return m.history.list({ project }).map((entry) => entry.record.operation);
    },
    async undo(): Promise<void> {
      await m.store.lock(project, () => m.history.undo(project));
    },
    /** How many records the project has written. */
    count(): number {
      return m.store.listRecords(project).length;
    },
    id(record: ProjectRecord | null): RecordId {
      return defined(record, "the record").id;
    },
    report(result: RunResult): AssetListReport {
      return standIn<AssetListReport>(result.report);
    },
  };
}
