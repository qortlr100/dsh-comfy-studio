/**
 * The reducer registry and project state. Components register one reducer per component key; the state at a record
 * is the result of passing every record of its chain (`ancestors` in the record store),
 * oldest first, through every registered reducer, then every record outside the history (`OperationSpec.outsideHistory`),
 * in write order, through the reducer of its component only. Project registers its own reducer, {@link projReducer}, for the
 * `proj` slice.
 *
 * Reference kinds register here too: each answers for the versions of its kind from its owner's slice.
 *
 * Calls: reads records through the record store and the chain through the history module. Called by the
 * service (`getState`) and the runner (state at a record's parent, version resolution).
 *
 * @module @cs/project/reducers
 */
import type { RecordStore } from "./record-store.ts";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { versionRefOf } from "./grammar.ts";
import { ProjectError } from "./shared.ts";
import type {
  AssetId,
  AssetStore,
  ComponentStates,
  ProjectId,
  ProjectInfo,
  ProjectRecord,
  ProjectState,
  RecordId,
  RecordInput,
  RecordInputRef,
  Reducer,
  ReferenceKindSpec,
  SessionId,
} from "./types.ts";

/** The `proj` slice. */
type ProjSlice = ComponentStates["proj"];

/** A slice of any declared component. */
type AnySlice = ComponentStates[keyof ComponentStates];

/** The sort key of a component key: `proj` first, the others by their key. */
function sortKey(key: string): string {
  return key === "proj" ? "" : key;
}

/** The record that created the version a reference names; null for any other reference. */
type VersionCreator = (ref: RecordInputRef) => RecordId | null;

/** The version lookup without reference kinds: no reference names a version. */
const noVersions: VersionCreator = () => null;

/**
 * The records that a `proj.stale_accept` record among the given records accepted.
 * @param records - records, oldest first.
 * @returns the accepted record IDs.
 */
function acceptedRecords(records: ProjectRecord[]): Set<string> {
  const accepted = new Set<string>();
  for (const record of records) {
    if (record.operation === "proj.stale_accept" && typeof record.params.record === "string")
      accepted.add(record.params.record);
  }
  return accepted;
}

/**
 * The records an input was produced by: the record that created its resolved asset, and for a version reference, the
 * record that created that version.
 * @param input - one input of a record.
 * @param created_by - the asset → record map of the slice.
 * @param versionCreator - the version lookup.
 * @returns the producing records.
 */
function producersOf(
  input: RecordInput,
  created_by: ProjSlice["created_by"],
  versionCreator: VersionCreator,
): RecordId[] {
  const producers: RecordId[] = [];
  const assetProducer =
    input.resolved_asset === null ? undefined : created_by[input.resolved_asset];
  if (assetProducer !== undefined) producers.push(assetProducer);
  const versionProducer =
    "asset" in input.ref || "record" in input.ref ? null : versionCreator(input.ref);
  if (versionProducer !== null) producers.push(versionProducer);
  return producers;
}

/**
 * Why a record is stale: the superseding record (or the record that made the producer stale) of the first input whose
 * producer is superseded or stale. A record is never stale through itself.
 * @param record - the record.
 * @param slice - the slice whose `created_by`, `superseded` and `stale` maps are read.
 * @param versionCreator - finds the producer of a version reference.
 * @returns the record that makes it stale, or undefined.
 */
function staleReason(
  record: ProjectRecord,
  slice: Pick<ProjSlice, "created_by" | "superseded" | "stale">,
  versionCreator: VersionCreator,
): RecordId | undefined {
  for (const input of record.inputs) {
    for (const producer of producersOf(input, slice.created_by, versionCreator)) {
      if (producer === record.id) continue;
      const reason = slice.superseded[producer] ?? slice.stale[producer];
      if (reason !== undefined && reason !== record.id) return reason;
    }
  }
  return undefined;
}

/**
 * Recompute every stale mark over a list of records in one forward pass, so that a mark reaches every record that is
 * downstream of a superseded record, and no mark reaches an accepted record or passes through one.
 * @param records - the records, oldest first; producers come before their consumers.
 * @param slice - the `created_by` and `superseded` maps after the newest record.
 * @param versionCreator - finds the producer of a version reference.
 * @returns the stale map.
 */
function computeStale(
  records: ProjectRecord[],
  slice: Pick<ProjSlice, "created_by" | "superseded">,
  versionCreator: VersionCreator,
): ProjSlice["stale"] {
  const accepted = acceptedRecords(records);
  const stale: ProjSlice["stale"] = {};
  for (const record of records) {
    if (accepted.has(record.id)) continue;
    const reason = staleReason(record, { ...slice, stale }, versionCreator);
    if (reason !== undefined) stale[record.id] = reason;
  }
  return stale;
}

/**
 * Apply one record to the `proj` slice (see {@link projReducer}).
 * @param slice - the slice before the record.
 * @param record - the record.
 * @param versionCreator - finds the producer of a version reference, from the slice of the kind's owner, before the
 *   record.
 * @returns the slice after the record.
 */
function reduceProj(
  slice: ProjSlice,
  record: ProjectRecord,
  versionCreator: VersionCreator,
): ProjSlice {
  const records = [...slice.records, record];
  const created_by = { ...slice.created_by };
  if (record.status === "done") for (const asset of record.outputs) created_by[asset] = record.id;
  const superseded = { ...slice.superseded };
  for (const id of record.supersedes) superseded[id] = record.id;
  // A supersede or a stale acceptance can change the marks of earlier records; anything else only marks this one.
  if (record.supersedes.length > 0 || record.operation === "proj.stale_accept") {
    return {
      records,
      created_by,
      superseded,
      stale: computeStale(records, { created_by, superseded }, versionCreator),
    };
  }
  const reason = staleReason(
    record,
    { created_by, superseded, stale: slice.stale },
    versionCreator,
  );
  const stale =
    reason === undefined || acceptedRecords(slice.records).has(record.id)
      ? slice.stale
      : { ...slice.stale, [record.id]: reason };
  return { records, created_by, superseded, stale };
}

/**
 * Project's own reducer for the `proj` slice:
 * - `records`: every record it receives, in order;
 * - `created_by`: each output asset of a `done` record → that record (a later record that outputs the same asset
 *   replaces the entry);
 * - `superseded`: each ID in a record's `supersedes` → that record;
 * - `stale`: a record R is stale when one of its inputs was produced by a record that is superseded or stale; the
 *   producer of an input is the record that created its `resolved_asset`, and for a version reference also the record
 *   that created that version (`createdBy` of its reference kind); the value is the
 *   superseding record (or the record that made the producer stale). When a record supersedes another, every earlier
 *   record that is (transitively) downstream of the superseded one becomes stale.
 *   A `proj.stale_accept` record with `params.record` removes that record's mark and keeps it removed for the rest of
 *   the chain, and records downstream of it are not stale through it.
 * Request records and `proj.*` records other than `proj.stale_accept` change only `records`. The registry reduces the
 * slice with the `createdBy` of the reference kinds; `projReducer.reduce` called on its own finds no version producers.
 */
export const projReducer: Reducer<"proj"> = {
  initial: () => ({ records: [], stale: {}, superseded: {}, created_by: {} }),
  reduce: (slice, record) => reduceProj(slice, record, noVersions),
};

/** Reads the slice of a component key, given the reducer registered for it. */
type SliceReader = (key: keyof ComponentStates, reducer: Reducer) => AnySlice;

/** The registered reducers and reference kinds, and the state computed from them. */
export class ReducerRegistry {
  /** Component key → reducer, in registration order. */
  private readonly reducers = new Map<keyof ComponentStates, Reducer>();
  /** Reference kind → its spec, in registration order. */
  private readonly kinds = new Map<string, ReferenceKindSpec>();

  private readonly store: RecordStore;
  private readonly outsideHistory: (record: ProjectRecord) => boolean;

  /**
   * @param store - the record store, read for chains and project metadata.
   * @param outsideHistory - whether a record's operation is a setting outside the history; read at call time.
   */
  constructor(store: RecordStore, outsideHistory: (record: ProjectRecord) => boolean) {
    this.store = store;
    this.outsideHistory = outsideHistory;
  }

  /**
   * Register a component's reducer. One reducer per key: a second registration of a key throws `reducer_exists`.
   * @param key - the component key.
   * @param reducer - the reducer.
   * @returns a function that removes the registration.
   */
  register<K extends keyof ComponentStates>(key: K, reducer: Reducer<K>): () => void {
    if (this.reducers.has(key))
      throw new ProjectError(
        "reducer_exists",
        `A reducer for component ${key} is already registered.`,
      );
    this.reducers.set(key, reducer);
    return () => {
      if (this.reducers.get(key) === reducer) this.reducers.delete(key);
    };
  }

  /**
   * Register a reference kind. One owner per kind: a second registration of a kind throws `kind_exists`.
   * @param spec - the kind.
   * @returns a function that removes the registration.
   */
  registerKind<K extends keyof ComponentStates>(spec: ReferenceKindSpec<K>): () => void {
    if (this.kinds.has(spec.kind))
      throw new ProjectError("kind_exists", `Reference kind ${spec.kind} is already registered.`);
    this.kinds.set(spec.kind, spec);
    return () => {
      if (this.kinds.get(spec.kind) === spec) this.kinds.delete(spec.kind);
    };
  }

  /** @returns the registered reference kinds, in registration order. */
  listReferenceKinds(): readonly string[] {
    return [...this.kinds.keys()];
  }

  /**
   * The reference kinds that have a version of an ID: those whose `createdBy` answers on their owner's slice.
   * @param state - a project state.
   * @param id - the ID, such as `p1`.
   * @param version - the version number.
   * @returns the kinds, in registration order.
   */
  kindsWithVersion(state: ProjectState, id: string, version: number): string[] {
    return [...this.kinds.values()]
      .filter((spec) => {
        const owner = this.ownerSlice(spec, (key, reducer) => sliceOf(state, key, reducer));
        return owner !== undefined && spec.createdBy(owner, id, version) !== null;
      })
      .map((spec) => spec.kind);
  }

  /**
   * The reference kinds that have an ID: those whose `latest` answers on their owner's slice.
   * @param state - a project state.
   * @param id - the ID, such as `p1`.
   * @returns the kinds, in registration order.
   */
  kindsWithId(state: ProjectState, id: string): string[] {
    return this.listReferenceKinds().filter((kind) => this.latestVersion(state, kind, id) !== null);
  }

  /**
   * The newest version of an ID in one reference kind, from `latest` of the kind on its owner's slice.
   * @param state - a project state.
   * @param kind - a reference kind.
   * @param id - the ID.
   * @returns the version, or null for an unknown ID, a kind that is not registered, or an owner without a reducer.
   */
  latestVersion(state: ProjectState, kind: string, id: string): number | null {
    const spec = this.kinds.get(kind);
    const owner =
      spec === undefined
        ? undefined
        : this.ownerSlice(spec, (key, reducer) => sliceOf(state, key, reducer));
    return spec === undefined || owner === undefined ? null : spec.latest(owner, id);
  }

  /**
   * The project's current state: the state at its current position.
   * @param project - the project.
   * @returns the state.
   */
  getState(project: ProjectId): ProjectState {
    this.store.getProject(project);
    return this.stateAt(project, this.store.requireLine(project).at);
  }

  /**
   * The state at any record; the runner uses it for the state at a record's parent.
   * @param project - the project.
   * @param head - the record to compute the state at.
   * @returns the state of the chain ending at `head`, with every record outside the history written so far.
   */
  stateAt(project: ProjectId, head: RecordId): ProjectState {
    return this.reduceChain(
      this.store.getProject(project),
      this.store.ancestors(project, head),
      this.store.listRecords(project, this.outsideHistory),
    );
  }

  /**
   * Pass a list of records through every reducer, starting from each reducer's initial slice, then each record outside
   * the history through the reducer of its component only. Pure: the same records always give the same state.
   * @param info - the project's metadata.
   * @param records - a chain, oldest first; must not be empty.
   * @param outside - the records outside the history, in write order.
   * @returns the state at the last record of the chain.
   */
  reduceChain(
    info: ProjectInfo,
    records: ProjectRecord[],
    outside: ProjectRecord[] = [],
  ): ProjectState {
    const last = records.at(-1);
    if (last === undefined)
      throw new ProjectError(
        "invalid_params",
        `Project ${info.id} has no record to compute a state from.`,
      );
    const slices = new Map<keyof ComponentStates, AnySlice>();
    for (const [key, reducer] of this.reducers) slices.set(key, reducer.initial());
    // Each record passes through every reducer in registration order before the next record.
    for (const record of records) {
      for (const [key, reducer] of this.reducers) {
        slices.set(
          key,
          this.reduceSlice(reducer, slices.get(key) ?? reducer.initial(), record, slices),
        );
      }
    }
    // A setting outside the history belongs to its own component; the history position does not change it.
    for (const record of outside) {
      // The key is only used to look up the reducers; an unregistered component finds none and is skipped.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const key = record.component as keyof ComponentStates;
      const reducer = this.reducers.get(key);
      if (reducer !== undefined)
        slices.set(
          key,
          this.reduceSlice(reducer, slices.get(key) ?? reducer.initial(), record, slices),
        );
    }
    return { project: info, head: last.id, components: componentStates(slices) };
  }

  /**
   * The project summary fields of every reducer that defines `agentSummary`: Project's own `proj` slice first, then the
   * other components in the alphabetical order of their keys, so the order never depends on which plugin mounted first.
   * @param state - a project state.
   * @param assets - the asset store, for asset URLs.
   * @param session - the session whose agent reads the summary.
   * @returns one field object per such reducer.
   */
  agentSummaries(
    state: ProjectState,
    assets: Pick<AssetStore, "url">,
    session: SessionId,
  ): Array<Record<string, JsonValue>> {
    return [...this.reducers]
      .toSorted(([a], [b]) => sortKey(a).localeCompare(sortKey(b)))
      .flatMap(([key, reducer]) =>
        reducer.agentSummary === undefined
          ? []
          : [reducer.agentSummary(sliceOf(state, key, reducer), assets, state, session)],
      );
  }

  /**
   * Apply one record to one slice. Project's own `proj` slice also reads the version producers from the slices of the
   * kinds' owners, before the record; `proj` is registered first, so `slices` still holds those slices while `proj`
   * reduces.
   * @param reducer - the reducer of the slice.
   * @param slice - the slice before the record.
   * @param record - the record.
   * @param slices - every slice by key; the owners' slices are read before the record.
   * @returns the slice after the record.
   */
  private reduceSlice(
    reducer: Reducer,
    slice: AnySlice,
    record: ProjectRecord,
    slices: Map<keyof ComponentStates, AnySlice>,
  ): AnySlice {
    if (reducer !== projReducer) return reducer.reduce(slice, record);
    // The reducer is `projReducer`, so the slice is the one it produced: the `proj` slice.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return reduceProj(slice as ProjSlice, record, (ref) => this.versionCreator(slices, ref));
  }

  /**
   * The record that created a version, from `createdBy` of its reference kind on the owner's slice.
   * @param slices - every slice by key.
   * @param ref - a record input reference.
   * @returns the record, or null for an unknown version, a kind that is not registered, or another reference.
   */
  private versionCreator(
    slices: Map<keyof ComponentStates, AnySlice>,
    ref: RecordInputRef,
  ): RecordId | null {
    return this.askKind(
      ref,
      (key, owner) => slices.get(key) ?? owner.initial(),
      (spec, owner, id, n) => spec.createdBy(owner, id, n),
    );
  }

  /**
   * The assets a version reference stands for, from `assetsOf` of its reference kind.
   * @param state - the state at the record's parent.
   * @param ref - a version reference.
   * @returns the assets, or null for an unknown version, a kind that is not registered, or another reference.
   */
  assetsOf(state: ProjectState, ref: RecordInputRef): AssetId[] | null {
    return this.askKind(
      ref,
      (key, reducer) => sliceOf(state, key, reducer),
      (spec, owner, id, n) => spec.assetsOf(owner, id, n),
    );
  }

  /**
   * Ask the reference kind that a version reference names, on its owner's slice.
   * @param ref - a record input reference.
   * @param read - reads the owner's slice.
   * @param ask - the question.
   * @returns the answer; null for an asset or record reference, a kind that is not registered, or an owner without a
   *   reducer.
   */
  private askKind<T>(
    ref: RecordInputRef,
    read: SliceReader,
    ask: (spec: ReferenceKindSpec, owner: AnySlice, id: string, version: number) => T | null,
  ): T | null {
    const named = versionRefOf(ref);
    const spec = named === null ? undefined : this.kinds.get(named.kind);
    const owner = spec === undefined ? undefined : this.ownerSlice(spec, read);
    return named === null || spec === undefined || owner === undefined
      ? null
      : ask(spec, owner, named.id, named.version);
  }

  /**
   * The slice a reference kind answers from.
   * @param spec - the kind.
   * @param read - reads a slice by key.
   * @returns the slice of the kind's owner, or undefined when the owner has no reducer.
   */
  private ownerSlice(spec: ReferenceKindSpec, read: SliceReader): AnySlice | undefined {
    const reducer = this.reducers.get(spec.component);
    return reducer === undefined ? undefined : read(spec.component, reducer);
  }
}

/**
 * Set one slice of a `components` object under construction.
 * @param components - the object being built.
 * @param key - the component key.
 * @param slice - the key's slice.
 */
function setSlice<K extends keyof ComponentStates>(
  components: Partial<ComponentStates>,
  key: K,
  slice: ComponentStates[K],
): void {
  components[key] = slice;
}

/**
 * Build the `components` object of a state from slices by component key.
 * @param slices - one slice per registered reducer; Project registers `proj` at start, so the `proj` slice is present.
 * @returns the slices as `ComponentStates`.
 */
function componentStates(slices: Map<keyof ComponentStates, AnySlice>): ComponentStates {
  const components: Partial<ComponentStates> = {};
  for (const [key, slice] of slices) setSlice(components, key, slice);
  // Project registers the `proj` reducer at start and every registered reducer contributes its slice, so none is missing.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return components as ComponentStates;
}

/**
 * Read one component's slice from a state by key.
 * @param state - the state.
 * @param key - a registered component key.
 * @param reducer - the reducer registered for the key.
 * @returns the slice; a reducer registered after the state was computed starts from its initial slice.
 */
function sliceOf(state: ProjectState, key: keyof ComponentStates, reducer: Reducer): AnySlice {
  return Object.hasOwn(state.components, key) ? state.components[key] : reducer.initial();
}
