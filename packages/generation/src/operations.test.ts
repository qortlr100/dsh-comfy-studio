/**
 * The generation operations on the real project layer, catalog and workflow component, with fake `graph` entries: the
 * operation table, a batch that runs to its end, the refusals that write no record, how a batch ends when runs fail or
 * are stopped, the agent's call under the project setting, and the three reads.
 */
import { agentOrigin, defined, standIn, userOrigin } from "@cs/project/testing/support";
import { fakeGraphEntry, type FakeGraphEntry } from "@cs/catalog/testing/fake-provider";
import type { AssetId, RecordId } from "@cs/project/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "./testing/mount.ts";
import {
  GEN_OPERATIONS,
  type GenGetReport,
  type GenListReport,
  type GenRunReport,
} from "./types.ts";

/** The words of a description. */
function wordsOf(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

/** @returns an entry that fails its first run with `message` and runs the following ones as `entry` does. */
function failFirst(entry: FakeGraphEntry, message: string): FakeGraphEntry {
  const run = entry.run.bind(entry);
  let calls = 0;
  entry.run = (request, options) => {
    calls += 1;
    if (calls > 1) return run(request, options);
    return {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(message)) }),
    };
  };
  return entry;
}

/** The report of a finished record as the test reads it. */
function reportOf(f: Mounted, record: RecordId): GenRunReport {
  return standIn<GenRunReport>(
    defined(f.csProject.getRecord(f.project, record).report, "the report"),
  );
}

/** Mount with one fake entry and one workflow. */
async function mountWithEntry(options: Parameters<typeof fakeGraphEntry>[0] = {}) {
  const f = await mount();
  const entry = fakeGraphEntry(options);
  f.register(entry);
  const workflow = await f.makeWorkflow();
  return { f, entry, workflow };
}

describe("the operation table", () => {
  it("registers the four operations always and gen.run while the catalog serves graph", async () => {
    const f = await mount();
    const names = (): string[] => f.operationNames().filter((name) => name.startsWith("gen."));
    expect(names().toSorted()).toEqual(["gen.get", "gen.list", "gen.settings", "gen.targets"]);

    const removeA = f.register(fakeGraphEntry({ target: "a" }));
    const removeB = f.register(fakeGraphEntry({ target: "b" }));
    expect(names()).toContain("gen.run");
    removeA();
    expect(names()).toContain("gen.run");
    removeB();
    expect(names()).not.toContain("gen.run");
    expect(names()).toHaveLength(4);
  });

  it("declares the flags, the agent calls and the descriptions", async () => {
    const f = await mount();
    f.register(fakeGraphEntry());
    const spec = (name: string) =>
      defined(
        f.csProject.listOperations().find((candidate) => candidate.name === name),
        name,
      );

    const run = spec(GEN_OPERATIONS.run);
    expect(run).toMatchObject({
      component: "gen",
      version: "1",
      resource: "gpu",
      background: true,
      deterministic: false,
    });
    expect(run.inputs["media"]).toMatchObject({ type: "any", many: true });
    expect(run.inputs["media"]?.required).toBeUndefined();
    expect(run.outputs).toEqual([{ role: "output", type: "any" }]);
    const agent = run.agent;
    if (typeof agent !== "function") throw new Error("gen.run needs an agent function");
    expect(agent(f.state())).toBe("propose");
    await f.call(GEN_OPERATIONS.settings, { agent_run: true });
    expect(agent(f.state())).toBe("run");

    expect(spec(GEN_OPERATIONS.settings)).toMatchObject({
      agent: "none",
      outsideHistory: true,
      resource: "none",
    });
    for (const name of [GEN_OPERATIONS.targets, GEN_OPERATIONS.list, GEN_OPERATIONS.get]) {
      expect(spec(name)).toMatchObject({ readOnly: true, resource: "none" });
    }
    for (const name of Object.values(GEN_OPERATIONS)) {
      expect(wordsOf(spec(name).description)).toBeLessThanOrEqual(110);
      expect(spec(name).label).toBeDefined();
    }
  });
});

describe("gen.run", () => {
  it("answers pending at once, then ends done with the outputs imported and a report", async () => {
    const { f, entry, workflow } = await mountWithEntry({ outputs: 2 });

    const queued = defined((await f.run({ workflow, values: { "6.text": "a red fox" } })).record);
    expect(queued.status).toBe("pending");
    await f.csProject.wait(f.project, [queued.id]);
    const record = f.csProject.getRecord(f.project, queued.id);

    expect(record.status).toBe("done");
    expect(record.outputs).toHaveLength(2);
    expect(f.assets.get(defined(record.outputs[0]))).toMatchObject({
      mime: "image/png",
      name: "fake-1-1.png",
    });
    const report = reportOf(f, record.id);
    expect(report).toMatchObject({
      workflow,
      workflow_name: "Flow",
      target: { provider: "fake", target: "one" },
      values: { "6.text": "a red fox" },
    });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({ run: "fake-run-1", outputs: record.outputs });
    expect(Object.keys(report.runs[0]?.seeds ?? {})).toEqual(["3.seed"]);
    // The prepared graph is a blob; the entry got the values and the drawn seed.
    const blob = standIn<Record<string, { inputs: Record<string, unknown> }>>(
      JSON.parse(new TextDecoder().decode(f.assets.read(report.graph))),
    );
    expect(blob["6"]?.inputs["text"]).toBe("a red fox");
    expect(entry.runs[0]?.graph["6"]?.inputs["text"]).toBe("a red fox");
    expect(entry.runs[0]?.graph["3"]?.inputs["seed"]).toBe(report.runs[0]?.seeds["3.seed"]);
  });

  it("runs count times with distinct seeds and puts every output on the record", async () => {
    const { f, entry, workflow } = await mountWithEntry();

    const record = await f.runToEnd({ workflow, count: 3, label: "three" });

    expect(record.status).toBe("done");
    expect(record.outputs).toHaveLength(3);
    expect(entry.runs).toHaveLength(3);
    const runs = reportOf(f, record.id).runs;
    expect(runs.map((run) => run.run)).toEqual(["fake-run-1", "fake-run-2", "fake-run-3"]);
    expect(new Set(runs.map((run) => run.seeds["3.seed"])).size).toBe(3);
    expect(runs.flatMap((run) => run.outputs)).toEqual(record.outputs);
  });

  it("keeps a given seed for the first run only", async () => {
    const { f, workflow } = await mountWithEntry();

    const record = await f.runToEnd({ workflow, count: 2, values: { "3.seed": 42 } });

    const [first, second] = reportOf(f, record.id).runs;
    expect(first?.seeds["3.seed"]).toBe(42);
    expect(second?.seeds["3.seed"]).not.toBe(42);
  });

  it("uploads a media input through the asset reader and leaves the request's graph unchanged", async () => {
    const { f, entry, workflow } = await mountWithEntry();
    const image = f.upload("source pixels");

    const record = await f.runToEnd(
      { workflow, media_fields: ["10.image"] },
      { media: [{ asset: image }] },
    );

    expect(record.status).toBe("done");
    expect(entry.uploads).toEqual([{ asset: image, name: "ref.png", bytes: 13 }]);
    expect(entry.runs[0]?.graph["10"]?.inputs["image"]).toBe("example.png");
    expect(entry.runs[0]?.media).toEqual([{ node: "10", input: "image", asset: image }]);
    expect(record.inputs[0]?.resolved_asset).toBe(image);
  });

  it("takes a media input that names the output of an earlier step", async () => {
    const { f, entry, workflow } = await mountWithEntry();
    const first = await f.runToEnd({ workflow });

    const second = await f.runToEnd(
      { workflow, media_fields: ["10.image"] },
      { media: [{ record: first.id, output: 0 }] },
    );

    expect(second.status).toBe("done");
    expect(entry.uploads).toHaveLength(1);
    expect(entry.uploads[0]?.asset).toBe(first.outputs[0]);
  });

  it("applies the patch to this run only", async () => {
    const { f, entry, workflow } = await mountWithEntry();

    await f.runToEnd({
      workflow,
      ops: [{ op: "set", node: "6", input: "text", value: "patched" }],
    });

    expect(entry.runs[0]?.graph["6"]?.inputs["text"]).toBe("patched");
    expect(f.state().components.workflow?.items[workflow]?.nodes).toBe(8);
    const unpatched = await f.runToEnd({ workflow });
    expect(unpatched.status).toBe("done");
    expect(entry.runs[1]?.graph["6"]?.inputs["text"]).toBe("a cat");
  });

  it("passes the places of the media inputs and the graph to validate", async () => {
    const { f, entry, workflow } = await mountWithEntry();
    const validate = vi.spyOn(entry, "validate");
    const image = f.upload("pixels");

    await f.runToEnd({ workflow, media_fields: ["10.image"] }, { media: [{ asset: image }] });

    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0]?.[0].media).toEqual([{ node: "10", input: "image" }]);
    expect(validate.mock.calls[0]?.[0].graph["10"]?.inputs["image"]).toBe("example.png");
  });

  it("summarizes a queued and a finished batch", async () => {
    const { f, workflow } = await mountWithEntry({ outputs: 2 });
    const spec = defined(
      f.csProject.listOperations().find((candidate) => candidate.name === GEN_OPERATIONS.run),
    );

    const queued = defined((await f.run({ workflow, count: 2, label: "Batch" })).record);
    expect(spec.summarize(queued)).toBe('queued "Batch" (2 runs)');
    await f.csProject.wait(f.project, [queued.id]);

    expect(spec.summarize(f.csProject.getRecord(f.project, queued.id))).toBe(
      'ran "Batch": 4 outputs from 2 of 2 runs',
    );
    const plain = await f.runToEnd({ workflow });
    expect(spec.summarize(plain)).toBe('ran "Flow": 2 outputs from 1 of 1 run');
  });
});

/** Run `params`, expect the refusal, and expect that no record was written. */
async function refuses(
  f: Mounted,
  params: Record<string, unknown>,
  code: string,
  message: string,
  options: Parameters<Mounted["run"]>[1] = {},
): Promise<void> {
  const before = f.csProject.listRecords(f.project).length;
  await expect(f.run(params, options)).rejects.toMatchObject({ code });
  await expect(f.run(params, options)).rejects.toThrow(message);
  expect(f.csProject.listRecords(f.project)).toHaveLength(before);
}

describe("refusals that write no record", () => {
  it("refuses what the plan refuses", async () => {
    const { f, entry, workflow } = await mountWithEntry();

    await refuses(f, { workflow: "nope" }, "invalid_params", "Unknown workflow");
    await refuses(f, { workflow, values: { "3.steps": "many" } }, "invalid_params", "3.steps");
    await refuses(f, { workflow, count: 5 }, "invalid_params", "'count'");
    await refuses(f, { workflow, media_fields: ["10.image"] }, "invalid_params", "no media inputs");
    await refuses(
      f,
      { workflow, ops: [{ op: "remove", node: "6" }] },
      "invalid_params",
      "broken graph",
    );
    expect(entry.runs).toEqual([]);
  });

  it("refuses a media input whose kind does not fit the field", async () => {
    const { f, workflow } = await mountWithEntry();
    const audio = f.upload("a tune", "tune.mp3", "audio/mpeg");

    await refuses(f, { workflow, media_fields: ["10.image"] }, "invalid_inputs", "takes an image", {
      media: [{ asset: audio }],
    });
  });

  it("refuses a media input it cannot resolve and an asset the store does not hold", async () => {
    const { f, workflow } = await mountWithEntry();

    await refuses(f, { workflow, media_fields: ["10.image"] }, "invalid_inputs", "no output 0", {
      media: [{ record: workflow, output: 0 }],
    });
    const missing = brandString<AssetId>("f".repeat(64));
    const before = f.csProject.listRecords(f.project).length;
    await expect(
      f.run({ workflow, media_fields: ["10.image"] }, { media: [{ asset: missing }] }),
    ).rejects.toBeInstanceOf(Error);
    expect(f.csProject.listRecords(f.project)).toHaveLength(before);
  });

  it("refuses with the problems of validate, joined", async () => {
    const f = await mount();
    f.register(fakeGraphEntry({ problems: ["No checkpoint is loaded.", "Too many steps."] }));
    const workflow = await f.makeWorkflow();

    await refuses(f, { workflow }, "invalid_params", "No checkpoint is loaded. Too many steps.");
  });

  it("chooses the place: the target, the workflow's default, the only entry, else it refuses", async () => {
    const f = await mount();
    const a = fakeGraphEntry({ target: "a" });
    const b = fakeGraphEntry({ target: "b" });
    f.register(a);
    f.register(b);
    const plain = await f.makeWorkflow();
    const withDefault = await f.makeWorkflow({ target: { provider: "fake", target: "b" } });

    await refuses(f, { workflow: plain }, "invalid_params", "cs_gen_targets");
    await refuses(
      f,
      { workflow: plain, target: { provider: "fake", target: "missing" } },
      "invalid_params",
      "fake/missing",
    );
    await f.runToEnd({ workflow: withDefault });
    await f.runToEnd({ workflow: withDefault, target: { provider: "fake", target: "a" } });
    await f.runToEnd({ workflow: plain, target: { provider: "fake", target: "a" } });

    expect(b.runs).toHaveLength(1);
    expect(a.runs).toHaveLength(2);
  });
});

describe("how a batch ends", () => {
  it("fails with not_queued when the server refuses every run", async () => {
    const { f, workflow } = await mountWithEntry({ rejected: ["The model is missing."] });
    const before = f.assets.files.size;

    const record = await f.runToEnd({ workflow, count: 2 });

    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ code: "not_queued", message: "The model is missing." });
    expect(record.outputs).toEqual([]);
    // A batch without a report keeps no prepared-graph blob either.
    expect(f.assets.files.size).toBe(before);
  });

  it("fails with not_queued when a job queue refuses after queued", async () => {
    const { f, workflow } = await mountWithEntry({ rejectedLate: ["Node 4 has no checkpoint."] });

    const record = await f.runToEnd({ workflow });

    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ code: "not_queued", message: "Node 4 has no checkpoint." });
  });

  it("fails with run_failed and the first message when no run finished for other reasons", async () => {
    const { f, workflow } = await mountWithEntry({ failure: "The node crashed." });

    const record = await f.runToEnd({ workflow, count: 2 });

    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ code: "run_failed", message: "The node crashed." });
    expect(f.assets.files.size).toBe(2);
  });

  it("is done when one run fails and another finishes, with the error in its run", async () => {
    const f = await mount();
    f.register(failFirst(fakeGraphEntry(), "The node crashed."));
    const workflow = await f.makeWorkflow();

    const record = await f.runToEnd({ workflow, count: 2 });

    expect(record.status).toBe("done");
    expect(record.outputs).toHaveLength(1);
    const [first, second] = reportOf(f, record.id).runs;
    expect(first).toMatchObject({
      run: null,
      outputs: [],
      error: { code: "run_failed", message: "The node crashed." },
    });
    expect(second?.error).toBeUndefined();
    expect(second?.outputs).toHaveLength(1);
  });

  it("ends cancelled when a person stops it while the server holds the run and nothing finished", async () => {
    const { f, entry, workflow } = await mountWithEntry({
      hold: new Promise<void>(() => undefined),
    });
    const queued = defined((await f.run({ workflow })).record);
    await vi.waitFor(() => {
      expect(entry.runs).toHaveLength(1);
    });

    const stopped = await f.csProject.cancel(f.project, queued.id, userOrigin());

    expect(stopped.status).toBe("cancelled");
    expect(stopped.error?.code).toBe("stopped");
    expect(stopped.outputs).toEqual([]);
    expect(entry.cancelled).toEqual(["fake-run-1"]);
  });

  it("ends cancelled when the record is stopped before it started", async () => {
    const f = await mount();
    const entry = fakeGraphEntry({ hold: new Promise<void>(() => undefined) });
    f.register(entry);
    const workflow = await f.makeWorkflow();
    // The gpu limit is one: the second batch waits in the queue behind the first, which the server holds.
    const first = defined((await f.run({ workflow })).record);
    const second = defined((await f.run({ workflow })).record);
    await vi.waitFor(() => {
      expect(entry.runs).toHaveLength(1);
    });

    const stopped = await f.csProject.cancel(f.project, second.id, userOrigin());
    await f.csProject.cancel(f.project, first.id, userOrigin());

    expect(stopped.status).toBe("cancelled");
    expect(entry.runs).toHaveLength(1);
  });

  it("is done with stopped: true when a stop comes after a run finished", async () => {
    const f = await mount();
    const finishing = fakeGraphEntry();
    const holding = fakeGraphEntry({ hold: new Promise<void>(() => undefined) });
    const entry = fakeGraphEntry();
    let calls = 0;
    entry.run = (request, options) => {
      calls += 1;
      return (calls === 1 ? finishing : holding).run(request, options);
    };
    f.register(entry);
    const workflow = await f.makeWorkflow();
    const queued = defined((await f.run({ workflow, count: 3 })).record);
    await vi.waitFor(() => {
      expect(holding.runs).toHaveLength(1);
    });

    const stopped = await f.csProject.cancel(f.project, queued.id, userOrigin());

    expect(stopped.status).toBe("done");
    expect(stopped.outputs).toHaveLength(1);
    const report = reportOf(f, queued.id);
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0]?.error).toBeUndefined();
    expect(report.runs[1]?.error?.code).toBe("stopped");
    expect(report).toMatchObject({ stopped: true });
    expect(holding.cancelled).toHaveLength(1);
  });
});

describe("an agent's call", () => {
  it("is refused while the setting is off, and a proposal runs as the user's call once accepted", async () => {
    const { f, entry, workflow } = await mountWithEntry();
    const params = { workflow, values: { "6.text": "agent prompt" } };

    await expect(f.run(params, { agent: true })).rejects.toMatchObject({
      code: "agent_not_allowed",
    });
    const proposal = await f.csProject.propose({
      ...agentOrigin(),
      project: f.project,
      operation: GEN_OPERATIONS.run,
      params,
      inputs: [],
    });
    expect(entry.runs).toEqual([]);

    const outcome = await f.csProject.decideProposal(
      f.project,
      proposal.id,
      "accept",
      userOrigin(),
    );
    const written = defined(outcome.result?.record);
    expect(written.status).toBe("pending");
    expect(written.actor).toBe("user");
    await f.csProject.wait(f.project, [written.id]);

    expect(f.csProject.getRecord(f.project, written.id).status).toBe("done");
    expect(entry.runs[0]?.graph["6"]?.inputs["text"]).toBe("agent prompt");
  });

  it("runs at once after gen.settings turns agent_run on, and the setting survives undo", async () => {
    const { f, workflow } = await mountWithEntry();
    await f.call(GEN_OPERATIONS.settings, { agent_run: true });

    const queued = defined((await f.run({ workflow }, { agent: true })).record);
    expect(queued.actor).toBe("agent");
    expect(queued.status).toBe("pending");
    await f.csProject.wait(f.project, [queued.id]);
    expect(f.csProject.getRecord(f.project, queued.id).status).toBe("done");

    await f.csProject.undo(f.project);
    await f.csProject.undo(f.project);
    expect(f.state().components.gen?.settings.agent_run).toBe(true);
  });

  it("cannot change the setting", async () => {
    const { f } = await mountWithEntry();

    await expect(f.call(GEN_OPERATIONS.settings, { agent_run: true }, true)).rejects.toMatchObject({
      code: "agent_not_allowed",
    });
    await expect(f.call(GEN_OPERATIONS.settings, { agent_run: "yes" })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(f.state().components.gen?.settings.agent_run).toBe(false);
  });
});

describe("the reads", () => {
  it("lists the places with their facts and the reason for a silent server", async () => {
    const f = await mount();
    f.register(fakeGraphEntry({ target: "up", label: "Local" }));
    f.register(fakeGraphEntry({ target: "down", unreachable: "connection refused" }));

    const result = await f.call(GEN_OPERATIONS.targets);

    expect(result.report).toEqual({
      targets: [
        {
          provider: "fake",
          target: "up",
          label: "Local",
          kind: "fake",
          description: "A fake server for tests.",
          problem: null,
        },
        {
          provider: "fake",
          target: "down",
          label: null,
          kind: null,
          description: "A fake server for tests.",
          problem: "connection refused",
        },
      ],
    });
  });

  it("lists batches newest first with filters and a clamped limit, and reads one with its outputs", async () => {
    const { f, workflow } = await mountWithEntry({ outputs: 2 });
    const a = await f.runToEnd({ workflow, label: "first" });
    const b = await f.runToEnd({ workflow, label: "second", count: 2 });

    const listed = standIn<GenListReport>(defined((await f.call(GEN_OPERATIONS.list)).report));
    expect(listed.batches.map((batch) => batch.label)).toEqual(["second", "first"]);
    expect(listed.batches[0]).toMatchObject({
      record: b.id,
      workflow,
      workflow_name: "Flow",
      status: "done",
      count: 2,
      outputs: 4,
    });
    const limited = standIn<GenListReport>(
      defined((await f.call(GEN_OPERATIONS.list, { limit: 1 })).report),
    );
    expect(limited.batches).toHaveLength(1);
    const none = standIn<GenListReport>(
      defined((await f.call(GEN_OPERATIONS.list, { status: "failed" })).report),
    );
    expect(none.batches).toEqual([]);
    await expect(f.call(GEN_OPERATIONS.list, { limit: 1.5 })).rejects.toMatchObject({
      code: "invalid_params",
    });

    const got = standIn<GenGetReport>(
      defined((await f.call(GEN_OPERATIONS.get, { record: a.id })).report),
    );
    expect(got).toMatchObject({ record: a.id, label: "first", status: "done", workflow });
    expect(got.target).toEqual({ provider: "fake", target: "one" });
    const outputs = defined(got.runs[0]).outputs;
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({
      mime: "image/png",
      name: "fake-1-1.png",
      review: null,
    });
    expect(outputs[0]?.url).toContain("https://assets.example/");
  });

  it("reads a batch that has not ended and refuses a record that is not a generation", async () => {
    const { f, workflow } = await mountWithEntry({ hold: new Promise<void>(() => undefined) });
    const queued = defined((await f.run({ workflow, values: { "3.steps": 9 } })).record);

    const got = standIn<GenGetReport>(
      defined((await f.call(GEN_OPERATIONS.get, { record: queued.id })).report),
    );
    expect(got).toMatchObject({
      runs: [],
      target: null,
      values: { "3.steps": 9 },
    });
    await expect(f.call(GEN_OPERATIONS.get, { record: workflow })).rejects.toThrow(
      "Unknown generation",
    );
    await f.csProject.cancel(f.project, queued.id, userOrigin());
  });
});
