/**
 * Builders for the tests of the asset reducer, operations and listing: records, a state around a slice, and a fake
 * host view of the store.
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import type {
  AssetId,
  ProjectId,
  ProjectInfo,
  ProjectRecord,
  ProjectState,
  RecordId,
} from "@cs/project/types";
import { assetReducer } from "../reducer.ts";
import type { AssetSlice, StoredAsset } from "../types.ts";

/** @returns an asset ID with the given text. */
export function assetId(text: string): AssetId {
  return brandString<AssetId>(text);
}

/** @returns a record ID with the given text. */
export function recordId(text: string): RecordId {
  return brandString<RecordId>(text);
}

/** @returns the ISO time `seconds` after a fixed start. */
export function at(seconds: number): string {
  return new Date(Date.parse("2026-02-01T00:00:00.000Z") + seconds * 1000).toISOString();
}

/** What a test says about one record; the rest has defaults. */
export interface RecordSpec {
  id: string;
  operation: string;
  /** Seconds after the fixed start; becomes `created_at`. */
  time: number;
  params?: Record<string, unknown>;
  /** Assets of the `asset` input role. */
  assets?: AssetId[];
  outputs?: AssetId[];
  component?: string;
  status?: ProjectRecord["status"];
  intent?: string;
}

/** @returns the record a spec describes. */
export function makeRecord(spec: RecordSpec): ProjectRecord {
  return {
    id: recordId(spec.id),
    parents: [],
    kind: "operation",
    component: spec.component ?? spec.operation.split(".")[0] ?? "asset",
    operation: spec.operation,
    operation_version: "1",
    actor: "user",
    surface: "view",
    turn: null,
    session: null,
    tool_call: null,
    intent: spec.intent ?? "test",
    params: spec.params ?? {},
    inputs: (spec.assets ?? []).map((asset) => ({
      role: "asset",
      ref: { asset },
      resolved_asset: asset,
    })),
    outputs: spec.outputs ?? [],
    based_on: null,
    supersedes: [],
    deterministic: false,
    status: spec.status ?? "done",
    created_at: at(spec.time),
  };
}

/** One record of a timeline; `outside` marks an `asset.import`, which the registry reduces after the history. */
export interface Event {
  record: ProjectRecord;
  outside: boolean;
}

/** @returns an `asset.import` event of the assets. */
export function importEvent(id: string, time: number, outputs: AssetId[]): Event {
  return { record: makeRecord({ id, operation: "asset.import", time, outputs }), outside: true };
}

/** @returns the event of a record of the history chain. */
export function stepEvent(spec: RecordSpec): Event {
  return { record: makeRecord(spec), outside: false };
}

/** @returns the slice after the records, in the order given. */
export function fold(records: ProjectRecord[]): AssetSlice {
  let slice = assetReducer.initial();
  for (const record of records) slice = assetReducer.reduce(slice, record);
  return slice ?? { items: {}, folders: {}, marks: {} };
}

/**
 * @param a - an event.
 * @param b - an event.
 * @returns the order of their times.
 */
function byTime(a: Event, b: Event): number {
  if (a.record.created_at === b.record.created_at) return 0;
  return a.record.created_at < b.record.created_at ? -1 : 1;
}

/** @returns the slice for the order the registry uses: the chain in time order, then the imports in write order. */
export function reduceRegistryOrder(events: Event[]): AssetSlice {
  const chain = events.filter((event) => !event.outside).toSorted(byTime);
  const outside = events.filter((event) => event.outside).toSorted(byTime);
  return fold([...chain, ...outside].map((event) => event.record));
}

/** @returns the slice for strict real-time order, imports among the steps. */
export function reduceRealTimeOrder(events: Event[]): AssetSlice {
  return fold(events.toSorted(byTime).map((event) => event.record));
}

/** @returns a project state with the slice and the records of the history list. */
export function stateOf(
  slice: AssetSlice | undefined,
  records: ProjectRecord[] = [],
): ProjectState {
  const project: ProjectInfo = {
    id: brandString<ProjectId>("p1"),
    title: "Test",
    created_at: at(0),
    path: "/tmp/p1",
  };
  return {
    project,
    head: recordId("head"),
    components: {
      proj: { records, stale: {}, superseded: {}, created_by: {}, proposals: {} },
      ...(slice === undefined ? {} : { asset: slice }),
    },
  };
}

/** @returns a store entry. */
export function storedAsset(id: AssetId, name: string, mime = "image/png"): StoredAsset {
  return {
    id,
    mime,
    name,
    size_bytes: 10,
    created_by: null,
    created_at: at(0),
    width: null,
    height: null,
    duration_sec: null,
  };
}

/** A fake host view of the store. */
export interface FakeStore {
  entries: Map<AssetId, StoredAsset>;
  entry(asset: AssetId): StoredAsset | undefined;
  path(asset: AssetId): string;
  url(asset: AssetId): string;
  toolOf(operation: string): string | null;
}

/** @returns a fake store of the entries; `toolOf` names `gen.*` operations `cs_gen_*` and no others. */
export function fakeStore(entries: StoredAsset[] = []): FakeStore {
  const map = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    entries: map,
    entry: (asset) => map.get(asset),
    path: (asset) => `/store/${asset}`,
    url: (asset) => `/api/cs/asset?id=${asset}`,
    toolOf: (operation) =>
      operation.startsWith("gen.") ? `cs_${operation.replace(".", "_")}` : null,
  };
}
