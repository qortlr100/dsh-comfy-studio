import { describe, expect, it } from "vitest";
import { graphSummary, graphToText, MAX_LITERAL_CHARS, nodeLine } from "./graph-text.ts";
import type { ApiGraph } from "./workflow.ts";

const GRAPH: ApiGraph = {
  "10": { class_type: "SaveImage", inputs: { filename_prefix: "out", images: ["8", 0] } },
  "3": {
    class_type: "KSampler",
    inputs: { seed: 1, steps: 20, model: ["4", 0], positive: ["6", 0] },
    _meta: { title: "KSampler" },
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: 'a cat, "quoted"', clip: ["4", 1] },
    _meta: { title: "Positive" },
  },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "v1-5.safetensors" } },
  "8": { class_type: "VAEDecode", inputs: {} },
};

describe("nodeLine", () => {
  it("shows links before literals and the title only when it adds something", () => {
    expect(nodeLine("3", GRAPH["3"]!)).toBe("3 KSampler: model←4.0 positive←6.0 seed=1 steps=20");
    expect(nodeLine("6", GRAPH["6"]!)).toBe(
      '6 CLIPTextEncode "Positive": clip←4.1 text="a cat, \\"quoted\\""',
    );
    expect(nodeLine("8", GRAPH["8"]!)).toBe("8 VAEDecode");
  });

  it("cuts long strings", () => {
    const long = "x".repeat(MAX_LITERAL_CHARS + 20);
    const line = nodeLine("1", { class_type: "CLIPTextEncode", inputs: { text: long } });
    expect(line).toBe(
      `1 CLIPTextEncode: text=${JSON.stringify(`${"x".repeat(MAX_LITERAL_CHARS)}…`)}`,
    );
  });
});

describe("graphToText", () => {
  it("lists nodes in numeric id order", () => {
    expect(
      graphToText(GRAPH)
        .split("\n")
        .map((l) => l.split(" ")[0]),
    ).toEqual(["3", "4", "6", "8", "10"]);
  });

  it("filters to the requested nodes, skipping unknown ids", () => {
    expect(graphToText(GRAPH, ["10", "4", "99"])).toBe(
      '4 CheckpointLoaderSimple: ckpt_name="v1-5.safetensors"\n10 SaveImage: images←8.0 filename_prefix="out"',
    );
    expect(graphToText(GRAPH, [])).toBe("");
  });
});

describe("graphSummary", () => {
  it("counts nodes per class, most common first, with their ids", () => {
    const g: ApiGraph = { ...GRAPH, "7": { class_type: "CLIPTextEncode", inputs: {} } };
    expect(graphSummary(g)).toBe(
      [
        "노드 6개",
        "CLIPTextEncode ×2: 6, 7",
        "CheckpointLoaderSimple ×1: 4",
        "KSampler ×1: 3",
        "SaveImage ×1: 10",
        "VAEDecode ×1: 8",
      ].join("\n"),
    );
  });
});
