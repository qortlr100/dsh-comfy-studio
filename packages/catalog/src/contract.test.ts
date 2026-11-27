/**
 * The catalog contract end to end with the real project layer. The throwaway component `probe_gen` does what the
 * generation feature component (stage 2-3) and the Comfy provider (stage 4-2) will do, so read it as their model:
 *
 * - The operation exists only while the catalog serves the `graph` primitive (`csCatalog.whileServing`).
 * - `precondition` finds the entry the call's key names and refuses the call with the entry's `validate` problems
 *   before any record is written, as a `ProjectError` so that the view API answers it as a refusal.
 * - `execute` builds the request, iterates `entry.run` to its end, and only after `done` imports the output files
 *   as assets of the record, so that a run that fails halfway leaves no asset behind. It keeps the run ID, the
 *   sent graph and the progress count in the report.
 * - A server refusal (`RequestRejected`, before or after `queued`) fails the record with the code `NOT_QUEUED`;
 *   what counts runs leaves those records out.
 * - Stopping the call aborts the signal the entry receives; the entry decides whether the run was cancelled or had
 *   already finished.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import CsProject, {
  OperationFailure,
  ProjectError,
  type AssetId,
  type OperationContext,
  type OperationSpec,
  type ProjectId,
  type ProjectRecord,
  type RunResult,
} from "@cs/project";
import { MemoryAssets, defined, standIn, tempRoot, userOrigin } from "@cs/project/testing/support";
import { chatProject, provideChatServices } from "@cs/project/testing/workspaces";
import CsCatalog, {
  NOT_QUEUED,
  RequestRejected,
  type Graph,
  type GraphRequest,
  type GraphRunEvent,
} from "./index.ts";
import { fakeGraphEntry, fakeOutput, type FakeGraphEntry } from "./testing/fake-provider.ts";

/** An asset store that stores the bytes of a file when the source is a path (`MemoryAssets` stores the path text). */
class FileAssets extends MemoryAssets {
  override importAsset(
    project: ProjectId,
    source: Uint8Array | { path: string },
    meta: { mime: string; name: string },
  ): AssetId {
    const bytes = source instanceof Uint8Array ? source : readFileSync(source.path);
    return super.importAsset(project, Uint8Array.from(bytes), meta);
  }
}

/** The graph of the tests: a node `1` that loads an image and a node `2` that saves one. */
function graphOf(): Graph {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
  };
}

/** What the probe operation reports to the test about the run it executes. */
interface Hooks {
  /** Called with the run ID when the entry has queued the run. */
  queued?: (run: string) => void;
}

/**
 * @param value - a parameter value.
 * @returns the value as text; throws for another type.
 */
function textOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a text parameter.");
  return value;
}

/** The request the probe operation sends, from the call's params and the resolved `image` inputs. */
function requestOf(params: Record<string, unknown>, images: AssetId[]): GraphRequest {
  return {
    graph: standIn<Graph>(JSON.parse(textOf(params["graph"]))),
    media: images.map((asset) => ({ node: "1", input: "image", asset })),
  };
}

/** Mount the project layer, the catalog and the throwaway component, and make one project. */
async function mount() {
  const root = tempRoot();
  const context = new Context();
  onTestFinished(async () => {
    await context.fiber.dispose();
  });
  const services = provideChatServices(context);
  await context
    .plugin(CsProject, {
      projectsFolder: join(root, "projects"),
      cpuConcurrency: 1,
      gpuConcurrency: 1,
      promptSectionOrder: 4900,
    })
    .await();
  await context.plugin(CsCatalog, { factsTimeoutMs: 1000 }).await();
  const { csProject, csCatalog } = context;
  const assets = new FileAssets();
  csProject.registerAssetStore(assets);
  csProject.registerComponent("probe_gen");
  const hooks: Hooks = {};

  const operation: OperationSpec = {
    name: "probe_gen.run",
    component: "probe_gen",
    version: "1",
    description: "Run a graph on one catalog entry.",
    params: {
      provider: { type: "string", required: true, description: "The provider." },
      target: { type: "string", required: true, description: "The target." },
      graph: { type: "string", required: true, description: "The graph, as JSON text." },
    },
    inputs: { image: { type: "image", description: "A media input.", many: true } },
    // The outputs have no count: `execute` returns as many assets as the run yielded.
    outputs: [{ role: "image", type: "image" }],
    deterministic: false,
    resource: "gpu",
    summarize: (record) => `Generated ${String(record.outputs.length)} image(s).`,
    precondition: async (request) => {
      const { provider, target, graph } = request.params;
      // The inputs are not resolved to assets yet. The draft says where they will go, so that the provider does not
      // judge the placeholder the graph holds there.
      const media = (request.inputs ?? [])
        .filter((input) => input.role === "image")
        .map(() => ({ node: "1", input: "image" }));
      const key = {
        primitive: "graph",
        provider: textOf(provider),
        target: textOf(target),
      } as const;
      const entry = csCatalog.get(key);
      if (entry === undefined) {
        throw new ProjectError(
          "invalid_params",
          `There is no catalog entry ${key.primitive}/${key.provider}/${key.target}.`,
        );
      }
      const problems = await entry.validate({ graph: requestOf({ graph }, []).graph, media });
      if (problems.length > 0) throw new ProjectError("invalid_params", problems.join(" "));
    },
    execute: async (call: OperationContext) => {
      const entry = defined(
        csCatalog.get({
          primitive: "graph",
          provider: textOf(call.params["provider"]),
          target: textOf(call.params["target"]),
        }),
        "the catalog entry",
      );
      const images = call.inputs
        .filter((input) => input.role === "image")
        .map((input) => defined(input.resolved_asset, "a resolved input"));
      let run = "";
      let sent: Graph = {};
      let progress = 0;
      let done = false;
      const files: Array<Extract<GraphRunEvent, { kind: "output" }>> = [];
      try {
        for await (const event of entry.run(requestOf(call.params, images), {
          dir: call.scratchDir,
          assets: csProject.assets(),
          signal: call.signal,
        })) {
          if (event.kind === "queued") {
            run = event.run;
            sent = event.graph;
            hooks.queued?.(run);
          } else if (event.kind === "progress") {
            progress += 1;
          } else if (event.kind === "output") {
            files.push(event);
          } else {
            done = true;
          }
        }
      } catch (error) {
        // A refusal queued nothing: the record fails with a code that counts leave out.
        if (error instanceof RequestRejected) throw new OperationFailure(NOT_QUEUED, error.message);
        throw error;
      }
      if (!done) throw new Error("The run ended without finishing.");
      // The files stay in the scratch directory until this call returns; nothing is imported for a failed run.
      const outputs = files.map((file) =>
        call.importAsset({ path: file.path }, { mime: file.mime, name: file.name }),
      );
      return { outputs, report: { run, graph: sent, progress } };
    },
  };

  const registerEntry = (entry: FakeGraphEntry): (() => void) => csCatalog.register(entry);
  context.effect(() =>
    csCatalog.whileServing(["graph"], () => csProject.registerOperation(operation)),
  );
  const project = await chatProject(csProject, services, "Probe", userOrigin());

  return {
    assets,
    hooks,
    project,
    registerEntry,
    csProject,
    /** Run `probe_gen.run` on `entry`. */
    run(
      entry: FakeGraphEntry,
      options: { graph?: Graph; images?: AssetId[]; signal?: AbortSignal } = {},
    ): Promise<RunResult> {
      return csProject.run({
        ...userOrigin(),
        project,
        operation: "probe_gen.run",
        params: {
          provider: entry.provider,
          target: entry.target,
          graph: JSON.stringify(options.graph ?? graphOf()),
        },
        inputs: (options.images ?? []).map((asset) => ({ role: "image", ref: { asset } })),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    },
    /** The records of the operation. */
    records(): ProjectRecord[] {
      return csProject
        .listRecords(project)
        .filter((record) => record.operation === "probe_gen.run");
    },
  };
}

/** The sha256 hex digest of bytes, which is the asset ID the store gives them. */
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("a generation operation over the catalog", () => {
  it("writes one record that ends done, with the bytes the provider wrote and a report of the run", async () => {
    const f = await mount();
    const entry = fakeGraphEntry();
    f.registerEntry(entry);

    const result = await f.run(entry);

    const record = defined(result.record);
    expect(record.status).toBe("done");
    expect(f.records()).toHaveLength(1);
    expect(record.outputs).toHaveLength(1);
    const [asset] = record.outputs;
    expect(f.assets.get(defined(asset))).toMatchObject({ mime: "image/png", name: "fake-1-1.png" });
    expect(f.assets.read(defined(asset))).toEqual(fakeOutput("fake-1-1.png"));
    expect(String(asset)).toBe(digest(fakeOutput("fake-1-1.png")));
    expect(result.report).toEqual({ run: "fake-run-1", graph: graphOf(), progress: 1 });
  });

  it("uploads a media input through the asset reader and keeps the request's graph unchanged", async () => {
    const f = await mount();
    const entry = fakeGraphEntry();
    f.registerEntry(entry);
    const image = f.assets.importAsset(f.project, Buffer.from("source pixels"), {
      mime: "image/png",
      name: "source.png",
    });

    const result = await f.run(entry, { images: [image] });

    expect(defined(result.record).status).toBe("done");
    expect(entry.uploads).toEqual([{ asset: image, name: "source.png", bytes: 13 }]);
    const sent = standIn<Graph>(result.report?.["graph"]);
    expect(sent["1"]?.inputs["image"]).toBe("uploaded-source.png");
    // The record's params hold the graph as the caller wrote it.
    expect(defined(result.record).params["graph"]).toBe(JSON.stringify(graphOf()));
    expect(entry.runs[0]?.graph["1"]?.inputs["image"]).toBe("placeholder.png");
  });

  it("refuses a call with the problems of validate before it writes a record", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ problems: ["No checkpoint is loaded.", "Too many steps."] });
    f.registerEntry(entry);
    const before = f.csProject.listRecords(f.project).length;

    const refusal = f.run(entry);
    await expect(refusal).rejects.toThrow("No checkpoint is loaded. Too many steps.");
    // A refusal the view API answers with 400, not an unexpected failure.
    await expect(refusal).rejects.toMatchObject({ name: "ProjectError", code: "invalid_params" });

    expect(f.csProject.listRecords(f.project)).toHaveLength(before);
    expect(entry.runs).toEqual([]);
  });

  it("names the key when no entry is registered under it", async () => {
    const f = await mount();
    const known = fakeGraphEntry();
    f.registerEntry(known);

    await expect(f.run(fakeGraphEntry({ target: "missing" }))).rejects.toThrow(
      "graph/fake/missing",
    );
  });

  it("fails the record with NOT_QUEUED when the server refuses, and counts runs without those records", async () => {
    const f = await mount();
    const refusing = fakeGraphEntry({ target: "refusing", rejected: ["The model is missing."] });
    const working = fakeGraphEntry({ target: "working" });
    f.registerEntry(refusing);
    f.registerEntry(working);

    const refused = await f.run(refusing);
    await f.run(working);

    const record = defined(refused.record);
    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ code: NOT_QUEUED, message: "The model is missing." });
    expect(record.outputs).toEqual([]);
    // How a consumer counts runs: the records that were queued, whatever their end.
    const counted = f.records().filter((candidate) => candidate.error?.code !== NOT_QUEUED);
    expect(f.records()).toHaveLength(2);
    expect(counted).toHaveLength(1);
  });

  it("ends the record failed with operation_failed when the run fails after queued", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ failure: "The node crashed." });
    f.registerEntry(entry);

    const result = await f.run(entry);

    const record = defined(result.record);
    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ code: "operation_failed", message: "The node crashed." });
    expect(record.outputs).toEqual([]);
  });

  it("fails the record with NOT_QUEUED when a job queue reports the refusal after queued", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ rejectedLate: ["Node 4 has no such checkpoint."] });
    f.registerEntry(entry);

    const result = await f.run(entry);

    const record = defined(result.record);
    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ code: NOT_QUEUED, message: "Node 4 has no such checkpoint." });
    expect(f.assets.files.size).toBe(0);
  });

  it("imports nothing for a run that fails after it yielded an output", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ outputs: 2 });
    // The second output never arrives: the run fails between the two.
    const run = entry.run.bind(entry);
    entry.run = async function* (request, options) {
      let outputs = 0;
      for await (const event of run(request, options)) {
        if (event.kind === "output" && ++outputs === 2) throw new Error("The server went away.");
        yield event;
      }
    };
    f.registerEntry(entry);

    const result = await f.run(entry);

    expect(defined(result.record).status).toBe("failed");
    expect(defined(result.record).outputs).toEqual([]);
    expect(f.assets.files.size).toBe(0);
  });

  it("passes the places of the media inputs to validate, before the inputs are resolved", async () => {
    const f = await mount();
    const entry = fakeGraphEntry();
    const validate = vi.spyOn(entry, "validate");
    f.registerEntry(entry);
    const image = f.assets.importAsset(f.project, Buffer.from("source pixels"), {
      mime: "image/png",
      name: "source.png",
    });

    await f.run(entry, { images: [image] });

    expect(validate).toHaveBeenCalledWith({
      graph: graphOf(),
      media: [{ node: "1", input: "image" }],
    });
  });

  it("ends the record cancelled when the call stops while the run is held and the server cancels", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ hold: new Promise<void>(() => undefined) });
    f.registerEntry(entry);
    const controller = new AbortController();
    const queued = new Promise<string>((resolve) => {
      f.hooks.queued = resolve;
    });

    const running = f.run(entry, { signal: controller.signal });
    const run = await queued;
    controller.abort();
    const result = await running;

    const record = defined(result.record);
    expect(record.status).toBe("cancelled");
    expect(record.error?.code).toBe("stopped");
    expect(record.outputs).toEqual([]);
    expect(entry.cancelled).toEqual([run]);
  });

  it("keeps the result when the call stops but the server had already finished", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ hold: new Promise<void>(() => undefined), onAbort: "finished" });
    f.registerEntry(entry);
    const controller = new AbortController();
    const queued = new Promise<string>((resolve) => {
      f.hooks.queued = resolve;
    });

    const running = f.run(entry, { signal: controller.signal });
    const run = await queued;
    controller.abort();
    const result = await running;

    const record = defined(result.record);
    expect(record.status).toBe("done");
    expect(record.outputs).toHaveLength(1);
    expect(entry.cancelled).toEqual([run]);
  });

  it("registers the operation only while an entry is registered", async () => {
    const f = await mount();
    const names = (): string[] => f.csProject.listOperations().map((spec) => spec.name);
    expect(names()).not.toContain("probe_gen.run");

    const removeA = f.registerEntry(fakeGraphEntry({ target: "a" }));
    const removeB = f.registerEntry(fakeGraphEntry({ target: "b" }));
    expect(names()).toContain("probe_gen.run");
    removeA();
    expect(names()).toContain("probe_gen.run");
    removeB();
    expect(names()).not.toContain("probe_gen.run");
  });

  it("imports every output of a run in the order the run yielded them", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ outputs: 3 });
    f.registerEntry(entry);

    const result = await f.run(entry);

    expect(result.outputs.map((asset) => f.assets.get(asset).name)).toEqual([
      "fake-1-1.png",
      "fake-1-2.png",
      "fake-1-3.png",
    ]);
    expect(defined(result.record).outputs).toEqual(result.outputs);
  });
});

/** Options of a run outside any operation: a scratch directory and no assets. */
function optionsOf(signal?: AbortSignal) {
  return {
    dir: tempRoot(),
    assets: new MemoryAssets(),
    ...(signal === undefined ? {} : { signal }),
  };
}

describe("the fake provider keeps the rules of an entry", () => {
  it("cancels the run when the caller leaves its loop before the run ended", async () => {
    const entry = fakeGraphEntry({ outputs: 2 });
    const kinds: string[] = [];
    for await (const event of entry.run({ graph: graphOf(), media: [] }, optionsOf())) {
      kinds.push(event.kind);
      if (event.kind === "output") break;
    }
    expect(kinds).toEqual(["queued", "progress", "output"]);
    expect(entry.cancelled).toEqual(["fake-run-1"]);
  });

  it("cancels the run when the caller leaves right after queued", async () => {
    const entry = fakeGraphEntry();
    for await (const event of entry.run({ graph: graphOf(), media: [] }, optionsOf())) {
      expect(event.kind).toBe("queued");
      break;
    }
    expect(entry.cancelled).toEqual(["fake-run-1"]);
  });

  it("cancels nothing for a run that was read to its end", async () => {
    const entry = fakeGraphEntry();
    const kinds: string[] = [];
    for await (const event of entry.run({ graph: graphOf(), media: [] }, optionsOf())) {
      kinds.push(event.kind);
    }
    expect(kinds).toEqual(["queued", "progress", "output", "done"]);
    expect(entry.cancelled).toEqual([]);
  });

  it("submits nothing when the signal is aborted before the iteration starts", async () => {
    const entry = fakeGraphEntry();
    const controller = new AbortController();
    controller.abort(new Error("stopped early"));
    const events = entry.run({ graph: graphOf(), media: [] }, optionsOf(controller.signal));
    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow("stopped early");
    expect(entry.runs).toEqual([]);
    expect(entry.cancelled).toEqual([]);
  });

  it("resumes the run that the run ID names, and no run it does not know", async () => {
    const entry = fakeGraphEntry({ resumable: true });
    const resume = (run: string): AsyncIterable<GraphRunEvent> => {
      if (entry.resume === undefined) throw new Error("The entry cannot resume.");
      return entry.resume(run, optionsOf());
    };
    const first: Graph = { first: { class_type: "A", inputs: {} } };
    const second: Graph = { second: { class_type: "B", inputs: {} } };
    for (const graph of [first, second]) {
      const kinds: string[] = [];
      for await (const event of entry.run({ graph, media: [] }, optionsOf()))
        kinds.push(event.kind);
      expect(kinds.at(-1)).toBe("done");
    }

    const resumed: GraphRunEvent[] = [];
    for await (const event of resume("fake-run-1")) resumed.push(event);

    // The events follow the first run's graph, though the second was queued after it.
    expect(resumed.map((event) => event.kind)).toEqual(["progress", "output", "done"]);
    expect(resumed[0]).toMatchObject({ kind: "progress", node: "first" });
    expect(resumed[1]).toMatchObject({ kind: "output", node: "first" });
    await expect(resume("fake-run-9")[Symbol.asyncIterator]().next()).rejects.toThrow(
      "no run fake-run-9",
    );
  });
});
