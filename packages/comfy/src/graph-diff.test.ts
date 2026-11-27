import { describe, expect, it } from "vitest";
import { diffGraphs } from "./graph-diff.ts";
import type { ApiGraph } from "./workflow.ts";

const base: ApiGraph = {
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, model: ["4", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
  "10": { class_type: "SaveImage", inputs: { filename_prefix: "out" }, _meta: { title: "저장" } },
};

function edit(fn: (g: ApiGraph) => void): ApiGraph {
  const g = structuredClone(base);
  fn(g);
  return g;
}

describe("diffGraphs", () => {
  it("reports nothing for identical runs", () => {
    expect(diffGraphs([base, structuredClone(base)])).toEqual([]);
  });

  it("lists changed literal and link inputs, skipping excluded ones", () => {
    const b = edit((g) => {
      g["3"]!.inputs.seed = 2;
      g["3"]!.inputs.steps = 30;
      g["3"]!.inputs.model = ["11", 0];
    });
    expect(diffGraphs([base, b], new Set(["3.seed"]))).toEqual([
      {
        nodeId: "3",
        label: "KSampler",
        input: "model",
        values: [
          ["4", 0],
          ["11", 0],
        ],
      },
      { nodeId: "3", label: "KSampler", input: "steps", values: [20, 30] },
    ]);
  });

  it("collapses added, removed and replaced nodes into one row, in node-id order", () => {
    const b = edit((g) => {
      delete g["10"];
      g["4"]!.class_type = "UNETLoader";
      g["11"] = { class_type: "LoraLoader", inputs: { strength_model: 1 } };
    });
    const rows = diffGraphs([base, b, base]);
    expect(rows.map((r) => [r.nodeId, r.input, r.values])).toEqual([
      ["4", null, ["CheckpointLoaderSimple", "UNETLoader", "CheckpointLoaderSimple"]],
      ["10", null, ["SaveImage", undefined, "SaveImage"]],
      ["11", null, [undefined, "LoraLoader", undefined]],
    ]);
    expect(rows[1]!.label).toBe("저장");
  });

  it("tells added, removed and replaced nodes apart between the first and last graph", () => {
    const b = edit((g) => {
      delete g["10"];
      g["4"]!.class_type = "UNETLoader";
      g["11"] = { class_type: "LoraLoader", inputs: {} };
    });
    expect(diffGraphs([base, b]).map((r) => [r.nodeId, r.kind])).toEqual([
      ["4", "replaced"],
      ["10", "removed"],
      ["11", "added"],
    ]);
    expect(diffGraphs([base, b, base]).map((r) => r.kind)).toEqual([
      "replaced",
      "replaced",
      "replaced",
    ]);
  });

  it("treats an input present in one run only as a change", () => {
    const b = edit((g) => {
      g["10"]!.inputs.extra = true;
    });
    expect(diffGraphs([base, b])).toEqual([
      { nodeId: "10", label: "저장", input: "extra", values: [undefined, true] },
    ]);
  });
});
