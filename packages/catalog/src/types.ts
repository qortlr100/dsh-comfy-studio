/**
 * Types of the generation catalog: the primitives and their types, the key of a catalog entry, the graph request and
 * its run events, and the entry that provider plugins implement. One entry is one place a request can run: for the
 * `graph` primitive, one registered ComfyUI server. `CatalogEntry<P>` takes the types of primitive `P`.
 *
 * The frame (a table of primitives extended by declaration merging, entries keyed and registered by providers) follows
 * DreamVerse `@dv/models`; see THIRD_PARTY_NOTICES.md.
 *
 * @module @cs/catalog/types
 */
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type { AssetId, AssetStore } from "@cs/project/types";

/**
 * A ComfyUI graph in API format: nodes by ID, each with its class and its inputs (a literal, or a link
 * `[node ID, output slot]`). Structurally the `ApiGraph` of `@cs/comfy/workflow`; declared here so that the contract
 * does not depend on the integration library.
 */
export type Graph = Record<string, GraphNode>;

/** One node of a {@link Graph}. */
export interface GraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
  /** ComfyUI's own annotations, such as the node's title. */
  _meta?: { title?: string };
}

/**
 * The generation primitives: one row per kind of request, with the facts an entry reports, the request, one event of
 * a run, and the entry fields that only this primitive has. The catalog declares only `graph`. A package that defines
 * another primitive declares its row through declaration merging:
 * `declare module "@cs/catalog" { interface PrimitiveTypes { <name>: { facts; request; event; entry } } }`.
 */
export interface PrimitiveTypes {
  graph: {
    facts: GraphFacts;
    request: GraphRequest;
    event: GraphRunEvent;
    entry: GraphLookups;
  };
}

/** One generation primitive, such as `graph`. */
export type PrimitiveId = keyof PrimitiveTypes;

/** The key of one catalog entry. */
export interface CatalogKey<P extends PrimitiveId = PrimitiveId> {
  primitive: P;
  /** The provider plugin's name for itself, such as `comfy`. */
  provider: string;
  /** The provider's ID of the place the request runs, such as the ID of a registered server. */
  target: string;
}

/** What a `graph` entry reports about itself, read from its server. */
export type GraphFacts = {
  /** The name the views and the agent show. */
  label: string;
  /** The provider's word for the kind of server, such as `local`, `cloud`, `runpod` or `modal`. */
  kind: string;
  /** What the server answered about itself, such as its version and devices. */
  system: Record<string, JsonValue>;
};

/** One media input of a graph request: the asset that the provider uploads and writes into the graph. */
export interface GraphMediaInput {
  /** The ID of the node that takes the file. */
  node: string;
  /** The name of that node's input. */
  input: string;
  asset: AssetId;
}

/**
 * One graph run: the whole graph as it is to be sent, with patches and field values already applied, and the media
 * inputs that are assets. The provider uploads each asset to its server just before queuing and writes the uploaded
 * name into `graph[node].inputs[input]`.
 */
export interface GraphRequest {
  graph: Graph;
  media: GraphMediaInput[];
}

/**
 * One event of a graph run, in order: one `queued`, any number of `progress` and `output` events, then one `done`.
 * A run that fails rejects the iteration instead of yielding `done`.
 */
export type GraphRunEvent =
  /** The server accepted the run. `graph` is what was sent, with the uploaded names of the media inputs. */
  | { kind: "queued"; run: string; graph: Graph }
  /** The node that is executing and, when it reports steps, how far it is; null where the server does not say. */
  | { kind: "progress"; node: string | null; value: number | null; max: number | null }
  /**
   * One output file, written into the caller's directory. `preview` is true for a temporary output, which a run
   * yields only when it saved none.
   */
  | { kind: "output"; node: string; name: string; mime: string; path: string; preview: boolean }
  | { kind: "done" };

/** The server lookups of a `graph` entry. Each is present only on an entry whose server can answer it. */
export interface GraphLookups {
  /**
   * @returns the server's node definitions by class, as its `/object_info` gives them.
   * @throws Error when the server cannot be reached.
   */
  nodeCatalog?(): Promise<Record<string, JsonValue>>;
  /**
   * @param folder - a model folder, such as `checkpoints`.
   * @returns the names of the model files in it.
   * @throws Error when the server cannot be reached.
   */
  listModelFiles?(folder: string): Promise<string[]>;
  /**
   * @param folder - a model folder.
   * @param file - a model file in it.
   * @returns the file's embedded metadata, or null when it has none.
   * @throws Error when the server cannot be reached.
   */
  modelFileMetadata?(folder: string, file: string): Promise<Record<string, string> | null>;
  /**
   * @param limit - the most runs to return.
   * @returns the server's own finished runs, the latest first, each with the graph it ran.
   * @throws Error when the server cannot be reached.
   */
  listRuns?(limit: number): Promise<Array<{ run: string; queuedAt: string | null; graph: Graph }>>;
}

/** What a run needs from its caller. */
export interface RunOptions {
  /** An existing directory that the provider writes output files into. The caller owns and removes it. */
  dir: string;
  /** Reads the assets that the request names. */
  assets: Pick<AssetStore, "get" | "read">;
  /** Stops the run; see {@link CatalogEntry.run}. */
  signal?: AbortSignal;
}

/**
 * One catalog entry, which a provider plugin implements and registers. The row of the entry's primitive in
 * {@link PrimitiveTypes} gives its extra fields and the types of its facts, request and events.
 *
 * Entries must honor these semantics:
 * - `facts()` resolves with values read from the server and rejects when the server cannot be reached.
 * - `validate(request)` queues nothing. It resolves with every reason the request cannot run that the provider can
 *   tell without queuing, and with an empty list when it finds none. It must answer quickly, from what the provider
 *   already holds where it can: callers run it before they write a record, under the project lock. It rejects when it
 *   cannot tell because the server cannot be reached.
 * - `run(request, options)` starts when it is first iterated. It rejects with `RequestRejected` when the server
 *   refuses the request, in which case nothing was queued and no event was yielded. Otherwise it yields the events of
 *   the primitive in order, and rejects for a failure after `queued`. The provider alone tracks the run, decides that
 *   it finished and collects its outputs.
 * - Aborting `options.signal` asks the server to cancel. When the server has already finished the run, the iteration
 *   still yields the outputs and `done`; otherwise it rejects with an `Error` (the signal's reason when that is
 *   one). The caller tells a stop from a failure by its own signal, not by the error.
 * - Two outputs of one run may hold the same bytes; a caller must not take the files of a run to be distinct.
 * - `resume(run, options)`, where present, follows a run that the server accepted earlier, with the events after
 *   `queued`.
 */
export type CatalogEntry<P extends PrimitiveId = PrimitiveId> = CatalogKey<P> &
  PrimitiveTypes[P]["entry"] & {
    /** What this entry is, for the agent and the user to choose between entries. */
    description: string;
    /**
     * @returns the facts of this entry.
     * @throws Error when the server cannot be reached.
     */
    facts(): Promise<PrimitiveTypes[P]["facts"]>;
    /**
     * Check one request without queuing it.
     * @param request - the request as `run` would receive it.
     * @returns the problems, each one sentence the agent can read; empty when none was found.
     * @throws Error when the server cannot be reached.
     */
    validate(request: PrimitiveTypes[P]["request"]): Promise<string[]>;
    /**
     * Run one request.
     * @param request - the request of the entry's primitive.
     * @param options - the output directory, the asset reader and the stop signal.
     * @returns the events of the run.
     */
    run(
      request: PrimitiveTypes[P]["request"],
      options: RunOptions,
    ): AsyncIterable<PrimitiveTypes[P]["event"]>;
    /**
     * Follow a run that was accepted earlier, for example after a restart.
     * @param run - the run ID of its `queued` event.
     * @param options - the output directory, the asset reader and the stop signal.
     * @returns the events of the run after `queued`.
     */
    resume?(run: string, options: RunOptions): AsyncIterable<PrimitiveTypes[P]["event"]>;
  };

/** A filter of `csCatalog.list`: an entry matches when it equals every given field. */
export type CatalogFilter = Partial<Pick<CatalogKey, "primitive" | "provider">>;

/**
 * One entry as the views read it: its key and description, the optional abilities it has, and its facts. `facts` is
 * null and `problem` says why when the entry's server did not answer in time.
 */
export interface CatalogSummaryItem {
  primitive: string;
  provider: string;
  target: string;
  description: string;
  /** The names of the optional methods the entry has, such as `nodeCatalog` or `resume`, in a fixed order. */
  abilities: string[];
  facts: PrimitiveTypes[PrimitiveId]["facts"] | null;
  problem: string | null;
}
