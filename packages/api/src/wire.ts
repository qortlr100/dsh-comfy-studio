/**
 * The JSON the browser receives: the project's current state (`ProjectState` with its component slices sent verbatim)
 * with the assets the state mentions, the history list, and the operation declarations a view turns into parameter
 * forms. Records travel as `ProjectRecord`, unchanged.
 *
 * This module holds types and pure functions only, so a browser half can import its types.
 *
 * @module @cs/api/wire
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import type {
  AssetId,
  ComponentStates,
  HistoryEntry,
  OperationSpec,
  ProjectId,
  ProjectInfo,
  ProjectLine,
  ProjectState,
  RecordId,
} from "@cs/project";

/** An asset as the asset store describes it. */
export interface WireAsset {
  id: AssetId;
  /** The media type, such as `image/png` or `video/mp4`. */
  mime: string;
  /** The display name. */
  name: string;
  /** The URL that serves the bytes. */
  url: string;
}

/** An asset as one project sees it: the store entry and the operation that made it. */
export interface ProjectAsset extends WireAsset {
  /** The operation of the current-state record that created the asset; null for an asset the project only references. */
  made_by: string | null;
}

/** The project's current state as the browser reads it. */
export interface WireState {
  project: ProjectInfo;
  /** The current position: the step whose state this is. */
  head: RecordId;
  /** The last step of the history list; redo can move the current position up to it. */
  tip: RecordId;
  /** One slice per registered reducer, as Project computed them. */
  components: ComponentStates;
  /** Every asset the current state mentions (see {@link mentionedAssets}) that the asset store holds. */
  assets: ProjectAsset[];
}

/** The history list as the browser reads it (`POST /api/cs/history`). */
export interface WireHistory {
  /** The entries, newest first, as `csProject.listHistory` returns them. */
  entries: HistoryEntry[];
  /** The store entry of every asset the entries name as an output or a resolved input. */
  assets: WireAsset[];
}

/** An operation declaration without its executable parts. */
export interface WireOperation {
  name: string;
  version: string;
  description: string;
  /** The name that views show for the operation; absent when the operation declares none. */
  label?: OperationSpec["label"];
  inputs: OperationSpec["inputs"];
  params: OperationSpec["params"];
  outputs: OperationSpec["outputs"];
  deterministic: boolean;
  /** The scheduler class: `none` for operations that wait in neither the CPU nor the GPU queue. */
  resource: OperationSpec["resource"];
}

/** One project as the project list returns it. */
export interface WireProject {
  id: ProjectId;
  title: string;
  created_at: string;
  /** The project folder. */
  path: string;
}

/**
 * Collect the assets the project's current state mentions: its created assets, and the outputs and resolved inputs of
 * its records. An asset of a step after the current position, or of a discarded step, is left out.
 * @param state - the project's current state.
 * @returns the asset IDs, each once, in first-mention order.
 */
export function mentionedAssets(state: ProjectState): AssetId[] {
  const { proj } = state.components;
  const seen = new Set<AssetId>();
  for (const id of Object.keys(proj.created_by)) seen.add(brandString<AssetId>(id));
  for (const record of proj.records) {
    for (const id of record.outputs) seen.add(id);
    for (const input of record.inputs) {
      if (input.resolved_asset !== null) seen.add(input.resolved_asset);
    }
  }
  return [...seen];
}

/**
 * Turn the project's current state into the wire form.
 * @param state - the current state.
 * @param line - the last step and the current position.
 * @param asset - looks an asset up; unknown IDs return null and are left out.
 * @returns the wire state.
 */
export function toWireState(
  state: ProjectState,
  line: ProjectLine,
  asset: (id: AssetId) => WireAsset | null,
): WireState {
  const { proj } = state.components;
  const byId = new Map(proj.records.map((record) => [record.id, record]));
  const assets = mentionedAssets(state).flatMap((id): ProjectAsset[] => {
    const found = asset(id);
    if (found === null) return [];
    const creator = proj.created_by[id];
    const madeBy = creator === undefined ? null : (byId.get(creator)?.operation ?? null);
    return [{ ...found, made_by: madeBy }];
  });
  return {
    project: state.project,
    head: line.at,
    tip: line.tip,
    components: state.components,
    assets,
  };
}

/**
 * Strip an operation spec to its declaration.
 * @param spec - a registered operation.
 * @returns the wire declaration.
 */
export function toWireOperation(spec: OperationSpec): WireOperation {
  return {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    ...(spec.label === undefined ? {} : { label: spec.label }),
    inputs: spec.inputs,
    params: spec.params,
    outputs: spec.outputs,
    deterministic: spec.deterministic,
    resource: spec.resource,
  };
}

/**
 * The project ID a request names, or null when it is missing or malformed.
 * @param value - the raw query or body value.
 * @returns the project ID.
 */
export function projectIdOf(value: unknown): ProjectId | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? brandString<ProjectId>(value)
    : null;
}
