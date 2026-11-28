/**
 * A mounted project layer for the tests of the workflow operations: the real runner, reducer registry and history over
 * temporary folders, with the workflow operations and reducer registered on top of an in-memory asset store that keeps
 * the bytes it is given.
 */
import type { ApiGraph, ObjectInfo } from "@cs/comfy/workflow";
import { ProjectError } from "@cs/project";
import type {
  AssetId,
  ProjectId,
  ProjectRecord,
  RecordId,
  RunResult,
  RunRequest,
} from "@cs/project";
import {
  agentOrigin,
  createTestProject,
  defined,
  standIn,
  startModules,
  userOrigin,
} from "@cs/project/testing/support";
import { workflowOperations } from "../operations.ts";
import { workflowReducer } from "../reducer.ts";
import {
  WORKFLOW_OPERATIONS,
  type WorkflowItem,
  type WorkflowSlice,
  type WorkflowTarget,
} from "../types.ts";
import { sampleGraph } from "./graphs.ts";

/** What a test says about one call beyond the operation and its params. */
export interface CallOptions {
  /** The graph file, by asset; the `file` input. */
  file?: AssetId;
  /** Call as an agent in a chat turn instead of as the user. */
  agent?: boolean;
  /** The project to call in; the first project by default. */
  project?: ProjectId;
  /** The run request's signal, to stop the call. */
  signal?: AbortSignal;
}

/** The text of an asset in the fake store. */
interface Blob {
  mime: string;
  name: string;
  bytes: Uint8Array;
}

/**
 * Mount the project layer with the workflow component and two projects.
 * @param setup - `objectInfo`: the node catalog the fake host answers with (none by default). `withHas`: give the
 *   operations an existence check (`has`) and count the reads.
 * @returns the handle the tests drive.
 */
export async function mount(setup: { objectInfo?: ObjectInfo; withHas?: boolean } = {}) {
  const m = startModules();
  const project: ProjectId = await createTestProject(m);
  const other: ProjectId = await createTestProject(m, "Other project");
  const blobs = new Map<AssetId, Blob>();
  const objectInfoCalls: Array<WorkflowTarget | null> = [];
  const state: { objectInfo: ObjectInfo | undefined; hold: Promise<void> | undefined } = {
    objectInfo: setup.objectInfo,
    hold: undefined,
  };

  // The runner's fake store hashes the bytes into an ID; this one also keeps them, so the operations can read them.
  const importBytes = m.assets.importAsset.bind(m.assets);
  m.assets.importAsset = (target, source, meta, createdBy) => {
    const id = importBytes(target, source, meta, createdBy);
    if (source instanceof Uint8Array)
      blobs.set(id, { mime: meta.mime, name: meta.name, bytes: source });
    return id;
  };
  /** @returns the blob of an asset. */
  const blobOf = (asset: AssetId): Blob => {
    const blob = blobs.get(asset);
    if (blob === undefined) throw new ProjectError("unknown_asset", `Unknown asset ${asset}.`);
    return blob;
  };

  const reads: AssetId[] = [];
  const operations = workflowOperations({
    read: (asset) => {
      reads.push(asset);
      return blobOf(asset).bytes;
    },
    ...(setup.withHas === true ? { has: (asset: AssetId) => blobs.has(asset) } : {}),
    facts: (asset) => {
      const blob = blobOf(asset);
      return { mime: blob.mime, name: blob.name, size_bytes: blob.bytes.length };
    },
    stateOf: (id) => m.reducers.getState(id),
    objectInfo: (target) => {
      objectInfoCalls.push(target);
      // Like the real service, an aborted wait answers nothing.
      return (state.hold ?? Promise.resolve()).then(() => state.objectInfo);
    },
  });
  m.runner.registerComponent("workflow");
  m.reducers.register("workflow", workflowReducer);
  for (const spec of operations) m.runner.registerOperation(spec);

  /** @returns the request for a call. */
  const requestOf = (
    operation: string,
    params: Record<string, unknown>,
    call: CallOptions,
  ): RunRequest => ({
    project: call.project ?? project,
    operation,
    params,
    inputs: call.file === undefined ? [] : [{ role: "file", ref: { asset: call.file } }],
    ...(call.signal === undefined ? {} : { signal: call.signal }),
    ...(call.agent === true ? agentOrigin() : userOrigin()),
  });

  const f = {
    modules: m,
    project,
    other,
    operations,
    blobs,
    objectInfoCalls,
    /** The assets the operations read through the host. */
    reads,
    defined,
    /** Hold the fake host's node catalog answer until `release` resolves (undefined: answer at once). */
    holdCatalog(release: Promise<void> | undefined): void {
      state.hold = release;
    },
    /** Change what the fake host answers as the node catalog. */
    setObjectInfo(info: ObjectInfo | undefined): void {
      state.objectInfo = info;
    },
    /** Put a file into the store, outside any project's records, and get its asset ID. */
    upload(bytes: Uint8Array, name: string, mime = "application/json"): AssetId {
      return m.assets.importAsset(project, bytes, { mime, name }, null);
    },
    /** Put an API-format graph into the store as a JSON file. */
    uploadGraph(graph: ApiGraph = sampleGraph(), name = "flow.json"): AssetId {
      return f.upload(new TextEncoder().encode(JSON.stringify(graph)), name);
    },
    run(
      operation: string,
      params: Record<string, unknown> = {},
      call: CallOptions = {},
    ): Promise<RunResult> {
      return m.runner.run(requestOf(operation, params, call));
    },
    propose(
      operation: string,
      params: Record<string, unknown> = {},
      call: CallOptions = {},
    ): Promise<ProjectRecord> {
      return m.runner.propose({ ...requestOf(operation, params, call), ...agentOrigin() });
    },
    /** Make a workflow from a graph as the user; returns its ID. */
    async make(
      graph: ApiGraph = sampleGraph(),
      params: Record<string, unknown> = {},
      call: CallOptions = {},
    ): Promise<RecordId> {
      const file = f.uploadGraph(graph);
      const result = await f.run(WORKFLOW_OPERATIONS.create, params, { file, ...call });
      return defined(result.record).id;
    },
    slice(id: ProjectId = project): WorkflowSlice {
      return defined(m.reducers.getState(id).components.workflow, "the workflow slice");
    },
    item(id: RecordId, inProject?: ProjectId): WorkflowItem {
      return defined(f.slice(inProject).items[id], "the workflow");
    },
    /** The graph of a workflow, read from its blob. */
    graphOf(id: RecordId, inProject?: ProjectId): ApiGraph {
      const text = new TextDecoder().decode(blobOf(f.item(id, inProject).graph).bytes);
      return standIn<ApiGraph>(JSON.parse(text));
    },
    /** The operations of the history list, newest first. */
    history(): Array<string | null> {
      return m.history.list({ project }).map((entry) => entry.record.operation);
    },
    async undo(): Promise<void> {
      await m.store.lock(project, () => m.history.undo(project));
    },
    /** How many records the project has written. */
    count(id: ProjectId = project): number {
      return m.store.listRecords(id).length;
    },
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the test names the report type it expects.
    report<T>(result: RunResult): T {
      return standIn<T>(result.report);
    },
  };
  return f;
}
