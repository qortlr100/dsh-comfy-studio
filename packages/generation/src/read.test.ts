/**
 * The reports of `gen.list` and `gen.get` and the agent summary, on hand-built states: the order, the filters, the
 * limits, a record without a report yet, and a record that does not parse.
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import type { ProjectId, RecordId } from "@cs/project/types";
import { describe, expect, it } from "vitest";
import { MemoryAssets } from "@cs/project/testing/support";
import { getReport, listReport, reviewOf, summaryOf } from "./read.ts";
import { assetOf, batch, recordOf, stateOf } from "./testing/states.ts";

const id = (text: string): RecordId => brandString<RecordId>(text);

/** A report as `gen.run` writes it, with `runs` of the given outputs. */
function reportWith(runs: Array<{ outputs: string[]; error?: { code: string; message: string } }>) {
  return {
    workflow: "wf",
    workflow_name: "Flow",
    target: { provider: "fake", target: "one" },
    graph: "g".repeat(64),
    values: { "6.text": "fox" },
    runs: runs.map((run, index) => ({
      run: `run-${String(index + 1)}`,
      seeds: { "3.seed": index },
      ...run,
    })),
  };
}

/** An asset store with two assets. */
function store(): MemoryAssets {
  const assets = new MemoryAssets();
  const project = brandString<ProjectId>("p");
  for (const name of ["one.png", "two.png"]) {
    assets.importAsset(project, Buffer.from(name), { mime: "image/png", name });
  }
  return assets;
}

describe("listReport", () => {
  it("lists the gen.run records newest first and ignores other records", () => {
    const state = stateOf({
      records: [
        batch("01", "done", { params: { workflow: "wf", label: "one" } }),
        recordOf("02", { operation: "workflow.update", component: "workflow" }),
        batch("03", "done", { params: { workflow: "wf", label: "three" } }),
      ],
    });

    expect(listReport(state).batches.map((entry) => entry.label)).toEqual(["three", "one"]);
  });

  it("reads a batch from its record: counts, error, workflow name from the report or the slice", () => {
    const state = stateOf({
      workflows: { wf: "Current name" },
      records: [
        batch("01", "done", {
          params: { workflow: "wf", count: 3 },
          outputs: [assetOf("a"), assetOf("b")],
          report: reportWith([{ outputs: ["a", "b"] }]),
        }),
        batch("02", "pending", { params: { workflow: "wf" } }),
        batch("03", "failed", {
          params: { workflow: "wf", label: " Named " },
          error: { code: "not_queued", message: "No." },
        }),
      ],
    });

    const [failed, pending, done] = listReport(state).batches;

    expect(done).toMatchObject({
      record: id("01"),
      label: "Flow",
      workflow: id("wf"),
      workflow_name: "Flow",
      status: "done",
      count: 3,
      outputs: 2,
    });
    expect(pending).toMatchObject({
      label: "Current name",
      workflow_name: "Current name",
      status: "pending",
      count: 1,
      outputs: 0,
    });
    expect(pending?.error).toBeUndefined();
    expect(failed).toMatchObject({ label: "Named", status: "failed", error: "No." });
  });

  it("names a batch of an unknown workflow by the workflow ID and 'generation'", () => {
    const state = stateOf({ records: [batch("01", "pending", { params: { workflow: "gone" } })] });

    expect(listReport(state).batches[0]).toMatchObject({
      label: "generation",
      workflow_name: "gone",
    });
  });

  it("filters by status and workflow", () => {
    const state = stateOf({
      records: [
        batch("01", "done", { params: { workflow: "a" } }),
        batch("02", "failed", { params: { workflow: "b" } }),
        batch("03", "done", { params: { workflow: "b" } }),
      ],
    });

    expect(listReport(state, { status: "done" }).batches.map((entry) => entry.record)).toEqual([
      id("03"),
      id("01"),
    ]);
    expect(listReport(state, { workflow: "b" }).batches).toHaveLength(2);
    expect(listReport(state, { status: "failed", workflow: "a" }).batches).toEqual([]);
  });

  it("clamps the limit to 1 to 50 and defaults to 10", () => {
    const records = Array.from({ length: 60 }, (_, index) => batch(String(index + 1), "done"));
    const state = stateOf({ records });

    expect(listReport(state).batches).toHaveLength(10);
    expect(listReport(state, { limit: 0 }).batches).toHaveLength(1);
    expect(listReport(state, { limit: -5 }).batches).toHaveLength(1);
    expect(listReport(state, { limit: 25 }).batches).toHaveLength(25);
    expect(listReport(state, { limit: 500 }).batches).toHaveLength(50);
  });

  it("skips a record whose params do not parse", () => {
    const state = stateOf({
      records: [
        batch("01", "done", { params: { workflow: 7 } }),
        batch("02", "done", { params: {} }),
        batch("03", "done"),
      ],
    });

    expect(listReport(state).batches.map((entry) => entry.record)).toEqual([id("03")]);
  });
});

describe("getReport", () => {
  it("reads the runs with their outputs from the store, skipping assets it no longer has", () => {
    const assets = store();
    const [one, two] = [...assets.files.keys()];
    const state = stateOf({
      reviews: { [String(one)]: "adopted" },
      records: [
        batch("01", "done", {
          params: { workflow: "wf", label: "Fox" },
          outputs: [assetOf(String(one))],
          report: reportWith([
            { outputs: [String(one), "gone".repeat(16)] },
            { outputs: [String(two)], error: { code: "stopped", message: "Stopped." } },
          ]),
        }),
      ],
    });

    const report = getReport(state, id("01"), assets);

    expect(report).toMatchObject({
      record: id("01"),
      label: "Fox",
      status: "done",
      workflow: id("wf"),
      workflow_name: "Flow",
      target: { provider: "fake", target: "one" },
      values: { "6.text": "fox" },
    });
    expect(report.runs[0]?.outputs).toEqual([
      {
        asset: assetOf(String(one)),
        mime: "image/png",
        name: "one.png",
        url: `https://assets.example/${String(one)}`,
        review: "adopted",
      },
    ]);
    expect(report.runs[1]).toMatchObject({
      run: "run-2",
      seeds: { "3.seed": 1 },
      error: { code: "stopped", message: "Stopped." },
    });
    // The second asset is in the store but not in the library slice: no review state.
    expect(report.runs[1]?.outputs[0]?.review).toBeNull();
    expect(report.error).toBeUndefined();
  });

  it("answers a batch without a report with its params' values and no runs", () => {
    const state = stateOf({
      workflows: { wf: "Flow now" },
      records: [
        batch("01", "running", { params: { workflow: "wf", values: { "3.steps": 9 } } }),
        batch("02", "failed", {
          params: { workflow: "wf" },
          error: { code: "run_failed", message: "Boom." },
        }),
      ],
    });

    expect(getReport(state, id("01"), store())).toMatchObject({
      status: "running",
      workflow_name: "Flow now",
      target: null,
      values: { "3.steps": 9 },
      runs: [],
    });
    expect(getReport(state, id("02"), store()).error).toEqual({
      code: "run_failed",
      message: "Boom.",
    });
  });

  it("does not throw for a report that does not parse", () => {
    const state = stateOf({
      records: [batch("01", "done", { report: { runs: "many", target: 3 } })],
    });

    expect(getReport(state, id("01"), store())).toMatchObject({ runs: [], target: null });
  });

  it("refuses an unknown record and a record of another operation", () => {
    const state = stateOf({
      records: [recordOf("01", { operation: "workflow.create", component: "workflow" })],
    });

    expect(() => getReport(state, id("nope"), store())).toThrow("Unknown generation 'nope'.");
    expect(() => getReport(state, id("01"), store())).toThrow("Unknown generation '01'.");
    expect(() => getReport(state, id("01"), store())).toThrowError(
      expect.objectContaining({ code: "invalid_params" }),
    );
  });
});

describe("reviewOf", () => {
  it("reads the library's review state by shape, and is null without a library or an item", () => {
    const state = stateOf({ reviews: { a: "pending" } });

    expect(reviewOf(state, assetOf("a"))).toBe("pending");
    expect(reviewOf(state, assetOf("b"))).toBeNull();
    expect(reviewOf(stateOf(), assetOf("a"))).toBeNull();
  });
});

describe("summaryOf", () => {
  it("has no recent list without batches", () => {
    const summary = summaryOf(stateOf());

    expect(summary).toEqual({ agent_may_run: false, unfinished: 0 });
    expect("recent" in summary).toBe(false);
  });

  it("lists the last five batches newest first and counts the unfinished ones", () => {
    const state = stateOf({
      gen: { settings: { agent_run: true } },
      workflows: { wf: "Flow" },
      records: [
        batch("01", "done"),
        batch("02", "done"),
        batch("03", "pending"),
        batch("04", "running"),
        batch("05", "failed", { params: { workflow: "wf", label: "Five" } }),
        batch("06", "done", { outputs: [assetOf("a"), assetOf("b")] }),
        batch("07", "cancelled"),
      ],
    });

    const summary = summaryOf(state);

    expect(summary.agent_may_run).toBe(true);
    expect(summary.unfinished).toBe(2);
    expect(summary.recent?.map((entry) => entry.id)).toEqual(["07", "06", "05", "04", "03"]);
    expect(summary.recent?.[1]).toEqual({ id: "06", label: "Flow", status: "done", outputs: 2 });
    expect(summary.recent?.[2]?.label).toBe("Five");
  });
});
