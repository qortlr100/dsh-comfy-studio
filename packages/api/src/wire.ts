/**
 * The JSON the browser receives: the project's current state (`ProjectState` with its component slices sent verbatim)
 * with the assets the state mentions, and the history list. Records travel as `ProjectRecord`, unchanged. The
 * operation declarations are in `wire-operation.ts`.
 *
 * This module holds types and pure functions only and imports no host type, so a browser half can import its types
 * (checked by `@cs/ui-shell`'s browser program).
 *
 * @module @cs/api/wire
 */
import { brandString } from "@deepseek-ai/dsh-brand";
// The type-only face of the project layer, not its index: the index imports host modules
// (node:fs and the like), and the operation types pull in dsh's host types, whose
// `Context.sessions` would replace the client's in a browser program that reads this module.
// Whatever needs `OperationSpec` lives in wire-operation.ts.
import type {
  AssetId,
  ComponentStates,
  HistoryEntry,
  ProjectId,
  ProjectInfo,
  ProjectLine,
  ProjectRecord,
  ProjectState,
  Proposal,
  RecordId,
  RecordInputRef,
} from "@cs/project/types";

/**
 * One entry of the generation catalog, as `GET /api/cs/catalog` lists it: its key, description, optional abilities and
 * facts; facts null and a problem when its server did not answer.
 */
export type { CatalogSummaryItem as WireCatalogEntry } from "@cs/catalog/types";

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

/** One project as the project list returns it. */
export interface WireProject {
  id: ProjectId;
  title: string;
  created_at: string;
  /** The project folder. */
  path: string;
}

/** What `POST /api/cs/proposal/decide` answers. */
export interface WireProposalDecision {
  /** The proposal after the decision. */
  proposal: Proposal;
  /** The record the accepted call wrote; null for a rejection or a proposal that was decided already. */
  record: ProjectRecord | null;
}

/**
 * The assets a version reference stands for, or null when no registered reference kind has the version; the view API
 * answers it with `csProject.assetsOf` on the current state.
 */
export type VersionAssets = (ref: RecordInputRef) => AssetId[] | null;

/**
 * Collect the assets the project's current state mentions: its created assets, the outputs and resolved inputs of
 * its records, and the assets that the inputs of its pending proposals name (an asset; an output of a record of the
 * current state that has it; a version, through `versionAssets`). An asset of a step after the current position, or of
 * a discarded step, is left out.
 * @param state - the project's current state.
 * @param versionAssets - the assets of a version reference; none by default.
 * @returns the asset IDs, each once, in first-mention order.
 */
export function mentionedAssets(
  state: ProjectState,
  versionAssets: VersionAssets = () => null,
): AssetId[] {
  const { proj } = state.components;
  const seen = new Set<AssetId>();
  for (const id of Object.keys(proj.created_by)) seen.add(brandString<AssetId>(id));
  for (const record of proj.records) {
    for (const id of record.outputs) seen.add(id);
    for (const input of record.inputs) {
      if (input.resolved_asset !== null) seen.add(input.resolved_asset);
    }
  }
  // A proposal card draws what the proposed call would read.
  const byId = new Map(proj.records.map((record) => [record.id, record]));
  for (const proposal of Object.values(proj.proposals)) {
    if (proposal.status !== "pending") continue;
    for (const { ref } of proposal.inputs) {
      if ("asset" in ref) seen.add(ref.asset);
      else if ("record" in ref) {
        const output = byId.get(ref.record)?.outputs[ref.output];
        if (output !== undefined) seen.add(output);
      } else for (const id of versionAssets(ref) ?? []) seen.add(id);
    }
  }
  return [...seen];
}

/**
 * Turn the project's current state into the wire form.
 * @param state - the current state.
 * @param line - the last step and the current position.
 * @param asset - looks an asset up; unknown IDs return null and are left out.
 * @param versionAssets - the assets of a version reference that a pending proposal's input names; none by default.
 * @returns the wire state.
 */
export function toWireState(
  state: ProjectState,
  line: ProjectLine,
  asset: (id: AssetId) => WireAsset | null,
  versionAssets: VersionAssets = () => null,
): WireState {
  const { proj } = state.components;
  const byId = new Map(proj.records.map((record) => [record.id, record]));
  const assets = mentionedAssets(state, versionAssets).flatMap((id): ProjectAsset[] => {
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
 * The project ID a request names, or null when it is missing or malformed.
 * @param value - the raw query or body value.
 * @returns the project ID.
 */
export function projectIdOf(value: unknown): ProjectId | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? brandString<ProjectId>(value)
    : null;
}
