/**
 * Tests of the reports of the workflow read operations.
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it } from "vitest";
import type { ApiGraph } from "@cs/comfy/workflow";
import type { AssetId, RecordId } from "@cs/project/types";
import { getReport, graphReport, listReport, patchReport, reportText } from "./read.ts";
import { sampleGraph, sampleObjectInfo } from "./testing/graphs.ts";
import { WORKFLOW_LIMITS, type WorkflowItem, type WorkflowSlice } from "./types.ts";

const rid = (text: string): RecordId => brandString<RecordId>(text);

/** @returns a workflow with defaults. */
function item(id: string, fields: Partial<WorkflowItem> = {}): WorkflowItem {
  return {
    id: rid(id),
    name: id,
    description: "",
    graph: brandString<AssetId>(`g-${id}`),
    fields: [],
    parent: null,
    target: null,
    nodes: 7,
    created_at: "2026-02-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z",
    ...fields,
  };
}

/** @returns a slice of the items. */
function sliceOf(...items: WorkflowItem[]): WorkflowSlice {
  return { items: Object.fromEntries(items.map((entry) => [entry.id, entry])) };
}

/** @returns a graph of `count` CLIPTextEncode nodes with long texts, to be over the text limit. */
function bigGraph(count: number): ApiGraph {
  const graph: ApiGraph = {};
  for (let i = 1; i <= count; i += 1) {
    graph[String(i)] = {
      class_type: i % 2 === 0 ? "CLIPTextEncode" : "KSampler",
      inputs: { text: `${"x".repeat(70)}${i}`, seed: i },
    };
  }
  return graph;
}

describe("listReport", () => {
  const slice = sliceOf(
    item("a", {
      name: "Portrait",
      description: "Studio light",
      updated_at: "2026-02-02T00:00:00.000Z",
    }),
    item("b", { name: "Landscape", updated_at: "2026-02-03T00:00:00.000Z", parent: rid("a") }),
    item("c", { name: "Portrait upscale", updated_at: "2026-02-03T00:00:00.000Z" }),
  );

  it("lists newest updated first, then by ID", () => {
    expect(listReport(slice).workflows.map((w) => w.id)).toEqual(["b", "c", "a"]);
  });

  it("filters by words in name or description, all of them, ignoring case", () => {
    expect(listReport(slice, "portrait").workflows.map((w) => w.id)).toEqual(["c", "a"]);
    expect(listReport(slice, "PORTRAIT studio").workflows.map((w) => w.id)).toEqual(["a"]);
    expect(listReport(slice, "nothing").workflows).toEqual([]);
    expect(listReport(slice, "  ").workflows).toHaveLength(3);
  });

  it("shows counts, parent and a cut description", () => {
    const long = sliceOf(
      item("a", {
        description: "d".repeat(500),
        fields: [
          {
            id: "3.steps",
            nodeId: "3",
            input: "steps",
            label: "s",
            type: "integer",
            default: 1,
          },
        ],
        parent: rid("p"),
      }),
    );
    const [entry] = listReport(long).workflows;
    expect(entry?.fields).toBe(1);
    expect(entry?.parent).toBe("p");
    expect(entry?.nodes).toBe(7);
    expect(entry?.description).toHaveLength(WORKFLOW_LIMITS.summaryDescriptionChars);
    expect(entry?.description.endsWith("…")).toBe(true);
  });

  it("is empty for an empty slice", () => {
    expect(listReport({ items: {} })).toEqual({ workflows: [] });
    expect(reportText(listReport({ items: {} }))).toBe("No workflows.");
  });
});

describe("getReport", () => {
  const slice = sliceOf(
    item("a", { name: "Base", target: { provider: "p", target: "t" } }),
    item("b", { name: "Variant 2", parent: rid("a"), created_at: "2026-02-02T00:00:00.000Z" }),
    item("c", { name: "Variant 1", parent: rid("a") }),
  );

  it("answers the workflow with its variants", () => {
    const report = getReport(slice, rid("a"));
    expect(report).toMatchObject({ id: "a", name: "Base", target: { provider: "p", target: "t" } });
    expect(report.parent).toBeNull();
    expect(report.variants).toEqual([
      { id: "c", name: "Variant 1" },
      { id: "b", name: "Variant 2" },
    ]);
  });

  it("names the parent when it is there and none when it is not", () => {
    expect(getReport(slice, rid("b")).parent).toEqual({ id: "a", name: "Base" });
    expect(getReport(sliceOf(item("b", { parent: rid("gone") })), rid("b")).parent).toBeNull();
  });

  it("refuses an unknown workflow", () => {
    expect(() => getReport(slice, rid("zz"))).toThrow("Unknown workflow 'zz'.");
  });

  it("has a text for the tool result", () => {
    expect(reportText(getReport(slice, rid("b")))).toContain('Variant of a "Base"');
  });
});

describe("graphReport", () => {
  it("answers one line per node for a small graph", () => {
    const report = graphReport(rid("a"), sampleGraph());
    expect(report).toMatchObject({ workflow: "a", nodes: 7, form: "nodes" });
    expect(report.text.split("\n")).toHaveLength(7);
    expect(report.text).toContain("3 KSampler:");
  });

  it("answers the outline for a graph over the limit", () => {
    const graph = bigGraph(200);
    const report = graphReport(rid("a"), graph);
    expect(report.form).toBe("outline");
    expect(report.nodes).toBe(200);
    expect(report.text.length).toBeLessThanOrEqual(WORKFLOW_LIMITS.graphTextChars + 100);
    expect(report.text).toContain("KSampler ×100");
  });

  it("answers the named nodes of a big graph", () => {
    const report = graphReport(rid("a"), bigGraph(200), ["1", "2", "nope"]);
    expect(report.form).toBe("nodes");
    expect(report.text.split("\n")).toHaveLength(2);
  });

  it("cuts a filtered read that is still too long at a line boundary", () => {
    const graph = bigGraph(400);
    const report = graphReport(rid("a"), graph, Object.keys(graph));
    expect(report.form).toBe("nodes");
    const lines = report.text.split("\n");
    expect(lines.at(-1)).toMatch(/^… \d+ more nodes left out/);
    expect(report.text.length).toBeLessThanOrEqual(WORKFLOW_LIMITS.graphTextChars + 100);
    const shown = lines.length - 1;
    expect(lines.at(-1)).toContain(`${400 - shown} more`);
    expect(lines[0]).toMatch(/^1 KSampler:/);
    expect(lines[shown - 1]).toMatch(/^\d+ \w+:/);
  });
});

describe("patchReport", () => {
  const id = rid("a");

  it("reports a bad patch as not ok, never throwing", () => {
    const schema = patchReport(id, sampleGraph(), [{ op: "nope" }]);
    expect(schema).toMatchObject({ ok: false, problems: [], added: [], removed: [], text: "" });
    expect(schema.error).toContain("Invalid patch");
    const missing = patchReport(id, sampleGraph(), [
      { op: "set", node: "99", input: "a", value: 1 },
    ]);
    expect(missing.ok).toBe(false);
    expect(missing.error?.startsWith("op 1: ")).toBe(true);
  });

  it("reports an added node", () => {
    const report = patchReport(id, sampleGraph(), [
      { op: "add", id: "30", class_type: "CLIPTextEncode", inputs: { text: "x" } },
    ]);
    expect(report).toMatchObject({ ok: true, added: ["30"], removed: [] });
    expect(report.error).toBeUndefined();
    expect(report.text).toBe('30 CLIPTextEncode: text="x"');
    expect(report.checked_against_server).toBe(false);
  });

  it("reports a changed literal and nothing for nodes left alone", () => {
    const report = patchReport(id, sampleGraph(), [
      { op: "set", node: "6", input: "text", value: "a dog" },
    ]);
    expect(report.ok).toBe(true);
    expect(report.added).toEqual([]);
    expect(report.text).toBe('6 CLIPTextEncode "Positive": clip←4.1 text="a dog"');
  });

  it("reports a removed node and the problems it makes", () => {
    const report = patchReport(id, sampleGraph(), [{ op: "remove", node: "7" }]);
    expect(report.removed).toEqual(["7"]);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.nodeId === "3" && p.input === "negative")).toBe(true);
    expect(report.text).toBe("");
    expect(reportText(report)).toContain("Removed: 7");
  });

  it("says when a server's catalog checked the patch", () => {
    const report = patchReport(
      id,
      sampleGraph(),
      [{ op: "add", id: "30", class_type: "NoSuchNode" }],
      sampleObjectInfo(),
    );
    expect(report.checked_against_server).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.nodeId)).toContain("30");
  });

  it("cuts a long text at a line boundary", () => {
    const ops = Array.from({ length: 100 }, (_, i) => ({
      title: "t".repeat(190),
      op: "add",
      id: String(100 + i),
      class_type: "CLIPTextEncode",
      inputs: { text: "y".repeat(200) },
    }));
    const report = patchReport(id, sampleGraph(), ops);
    expect(report.added).toHaveLength(100);
    expect(report.text.split("\n").at(-1)).toMatch(/more nodes left out/);
    expect(report.text.length).toBeLessThanOrEqual(WORKFLOW_LIMITS.graphTextChars + 100);
  });
});

describe("reads of odd IDs and cut text", () => {
  it("treats IDs named like members of Object.prototype as unknown workflows", () => {
    const slice = sliceOf(item("a"));
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(() => getReport(slice, rid(name))).toThrow(`Unknown workflow '${name}'.`);
    }
    // A parent that is only an inherited name is no parent.
    expect(
      getReport(sliceOf(item("b", { parent: rid("constructor") })), rid("b")).parent,
    ).toBeNull();
  });

  it("reports a patch on a node named like an inherited member as not ok", () => {
    const report = patchReport(rid("a"), sampleGraph(), [
      { op: "set", node: "constructor", input: "x", value: 1 },
    ]);
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/^op 1: /);
  });

  it("does not advise fewer nodes when the outline itself is cut", () => {
    const graph: ApiGraph = {};
    for (let i = 1; i <= 3000; i += 1) {
      graph[String(i)] = { class_type: `Class${i}`, inputs: { v: i } };
    }
    const report = graphReport(rid("a"), graph);
    expect(report.form).toBe("outline");
    const last = report.text.split("\n").at(-1) ?? "";
    expect(last).toMatch(/^… \d+ more lines left out; /);
    expect(last).not.toContain("ask for fewer");
    expect(last).toContain("`nodes`");
  });

  it("cuts a single over-long line by code points, never inside a surrogate pair", () => {
    const graph: ApiGraph = {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "😀".repeat(20_000) } },
    };
    const report = graphReport(rid("a"), graph, ["1"]);
    const first = report.text.split("\n")[0] ?? "";
    expect(first).toMatch(/^1 CLIPTextEncode/);
    expect(Array.from(first).length).toBeLessThanOrEqual(WORKFLOW_LIMITS.graphTextChars);
    // No lone surrogate anywhere.
    expect(report.text.isWellFormed()).toBe(true);
  });

  it("says so when none of the named nodes exist", () => {
    const report = graphReport(rid("a"), sampleGraph(), ["404", "constructor"]);
    expect(report.form).toBe("nodes");
    expect(report.text).toBe("None of the named nodes exist in this graph.");
    expect(graphReport(rid("a"), sampleGraph(), ["9"]).text).toContain("SaveImage");
  });
});
