/**
 * A fake `graph` catalog entry for tests: no server, a scripted run. It follows the semantics that `CatalogEntry`
 * documents, so a consumer of the catalog can be tested end to end without a ComfyUI server.
 *
 * @module @cs/catalog/testing/fake-provider
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetId } from "@cs/project/types";
import { RequestRejected } from "../rejected.ts";
import type { CatalogEntry, Graph, GraphRequest, GraphRunEvent, RunOptions } from "../types.ts";

/** What the fake does; every field is optional. */
export interface FakeGraphOptions {
  /** The provider name of the key; default "fake". */
  provider?: string;
  /** The target of the key; default "one". */
  target?: string;
  /** `facts().label`; default "Fake server". */
  label?: string;
  /** What `validate()` resolves with; default []. */
  problems?: string[];
  /** When set, `run()` rejects with `RequestRejected(rejected)` before any event. */
  rejected?: string[];
  /** When set, `run()` rejects with `Error(failure)` after `queued` and one `progress`. */
  failure?: string;
  /** When set, `facts()` rejects with `Error(unreachable)`. */
  unreachable?: string;
  /** How many `output` events a run yields; default 1. */
  outputs?: number;
  /** After `queued`, the run waits for this promise before it goes on (so a test can abort in between). */
  hold?: Promise<void>;
  /** What the fake server says when the run's signal is aborted: "cancelled" (default) or "finished". */
  onAbort?: "cancelled" | "finished";
  /** Whether the entry has the optional lookups (nodeCatalog, listModelFiles, modelFileMetadata, listRuns). */
  lookups?: boolean;
  /** Whether the entry has `resume()`. */
  resumable?: boolean;
}

/** The fake entry and what it recorded. */
// oxlint-disable-next-line typescript/no-unnecessary-type-arguments -- "graph" is the only primitive today; it is not the default by design.
export interface FakeGraphEntry extends CatalogEntry<"graph"> {
  /** Every request `run()` received, in order. */
  readonly runs: GraphRequest[];
  /** Every asset the fake uploaded: the asset ID, the name it read and the byte length. */
  readonly uploads: Array<{ asset: AssetId; name: string; bytes: number }>;
  /** The run IDs the fake server was asked to cancel. */
  readonly cancelled: string[];
}

/** The bytes of the tiny PNG every fake output file starts with. */
export const FAKE_PNG: Uint8Array = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/**
 * The bytes of one fake output file: the PNG, then the file's name, so that two outputs are two different files
 * (an asset store that names assets by their content keeps them apart).
 * @param name - the output's file name, such as `fake-1-2.png`.
 * @returns the bytes.
 */
export function fakeOutput(name: string): Uint8Array {
  return Uint8Array.from(Buffer.concat([FAKE_PNG, Buffer.from(name)]));
}

/**
 * Resolve when `signal` aborts.
 * @param signal - the signal, if any.
 * @returns a promise that never resolves without a signal, and a function that removes the listener.
 */
function whenAborted(signal: AbortSignal | undefined): { promise: Promise<void>; stop(): void } {
  if (signal === undefined) return { promise: new Promise<void>(() => undefined), stop() {} };
  if (signal.aborted) return { promise: Promise.resolve(), stop() {} };
  const { promise, resolve } = Promise.withResolvers<void>();
  const listening = new AbortController();
  signal.addEventListener("abort", () => resolve(), { once: true, signal: listening.signal });
  return {
    promise,
    stop: () => {
      listening.abort();
    },
  };
}

/**
 * Make a fake `graph` entry.
 * @param options - what the fake does.
 * @returns the entry; its `runs`, `uploads` and `cancelled` fill as it is used.
 */
export function fakeGraphEntry(options: FakeGraphOptions = {}): FakeGraphEntry {
  const outputCount = options.outputs ?? 1;
  const onAbort = options.onAbort ?? "cancelled";
  const runs: GraphRequest[] = [];
  const uploads: FakeGraphEntry["uploads"] = [];
  const cancelled: string[] = [];
  const queuedGraphs: Graph[] = [];
  let counter = 0;

  /** Steps 5 to 8 of a run: progress, the failure, the abort check, the outputs and `done`. */
  async function* finish(
    run: string,
    prefix: string,
    graph: Graph,
    runOptions: RunOptions,
  ): AsyncGenerator<GraphRunEvent> {
    const nodes = Object.keys(graph);
    let asked = false;
    // The server is asked once to cancel; whether it was still running decides what the iteration does next.
    const checkAbort = (): void => {
      const signal = runOptions.signal;
      if (signal?.aborted !== true) return;
      if (!asked) {
        asked = true;
        cancelled.push(run);
      }
      if (onAbort === "cancelled") {
        throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      }
    };
    checkAbort();
    yield { kind: "progress", node: nodes[0] ?? null, value: 1, max: 2 };
    if (options.failure !== undefined) throw new Error(options.failure);
    for (let index = 1; index <= outputCount; index += 1) {
      checkAbort();
      const name = `${prefix}-${String(index)}.png`;
      const path = join(runOptions.dir, name);
      writeFileSync(path, fakeOutput(name));
      yield {
        kind: "output",
        node: nodes[nodes.length - 1] ?? "0",
        name,
        mime: "image/png",
        path,
        preview: false,
      };
    }
    yield { kind: "done" };
  }

  async function* runGraph(
    request: GraphRequest,
    runOptions: RunOptions,
  ): AsyncGenerator<GraphRunEvent> {
    runs.push(request);
    if (options.rejected !== undefined) throw new RequestRejected(options.rejected);
    // Never change the caller's graph: the copy is what the "server" gets.
    const graph: Graph = structuredClone(request.graph);
    for (const item of request.media) {
      const node = graph[item.node];
      if (node === undefined) {
        throw new RequestRejected([`The graph has no node ${item.node} for the media input.`]);
      }
      const { name } = runOptions.assets.get(item.asset);
      const bytes = runOptions.assets.read(item.asset);
      uploads.push({ asset: item.asset, name, bytes: bytes.byteLength });
      node.inputs[item.input] = `uploaded-${name}`;
    }
    counter += 1;
    const number = counter;
    const id = `fake-run-${String(number)}`;
    queuedGraphs.push(graph);
    yield { kind: "queued", run: id, graph };
    if (options.hold !== undefined) {
      const aborted = whenAborted(runOptions.signal);
      try {
        await Promise.race([options.hold, aborted.promise]);
      } finally {
        aborted.stop();
      }
    }
    yield* finish(id, `fake-${String(number)}`, graph, runOptions);
  }

  const entry: FakeGraphEntry = {
    primitive: "graph",
    provider: options.provider ?? "fake",
    target: options.target ?? "one",
    description: "A fake server for tests.",
    runs,
    uploads,
    cancelled,
    facts() {
      if (options.unreachable !== undefined) return Promise.reject(new Error(options.unreachable));
      return Promise.resolve({
        label: options.label ?? "Fake server",
        kind: "fake",
        system: { version: "0.0.0" },
      });
    },
    validate(request) {
      const problems = [...(options.problems ?? [])];
      if (Object.keys(request.graph).length === 0) problems.push("The graph has no nodes.");
      return Promise.resolve(problems);
    },
    run: runGraph,
  };
  if (options.resumable === true) {
    entry.resume = (runId, runOptions) =>
      finish(runId, `${runId}-resumed`, queuedGraphs.at(-1) ?? {}, runOptions);
  }
  if (options.lookups === true) {
    entry.nodeCatalog = () => Promise.resolve({ FakeNode: { input: {}, output: [] } });
    entry.listModelFiles = (folder) => Promise.resolve([`${folder}-model.safetensors`]);
    entry.modelFileMetadata = () => Promise.resolve(null);
    entry.listRuns = (limit) =>
      Promise.resolve(
        queuedGraphs
          .map((graph, index) => ({
            run: `fake-run-${String(index + 1)}`,
            queuedAt: null,
            graph,
          }))
          .toReversed()
          .slice(0, limit),
      );
  }
  return entry;
}
