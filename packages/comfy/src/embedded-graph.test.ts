import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pngTextChunks } from "./support/png-text.ts";
import { embeddedApiGraph, graphFromPng } from "./embedded-graph.ts";

const FIXTURE = path.resolve(import.meta.dirname, "./support/__fixtures__/comfy-output.png");

function fixture(): Uint8Array {
  return new Uint8Array(fs.readFileSync(FIXTURE));
}

describe("embeddedApiGraph", () => {
  it("reads the prompt graph of a ComfyUI output PNG and ignores the UI workflow", () => {
    const entries = pngTextChunks(fixture());
    expect(entries.map(([k]) => k)).toEqual(["prompt", "workflow"]);
    const graph = embeddedApiGraph(entries);
    expect(graph).not.toBeNull();
    expect(Object.fromEntries(Object.entries(graph!).map(([id, n]) => [id, n.class_type]))).toEqual(
      {
        "3": "KSampler",
        "4": "CheckpointLoaderSimple",
        "5": "EmptyLatentImage",
        "6": "CLIPTextEncode",
        "7": "CLIPTextEncode",
        "8": "VAEDecode",
        "9": "SaveImage",
      },
    );
    expect(graph!["3"]!.inputs.model).toEqual(["4", 0]);
  });

  it("is null without a prompt entry or with one that is not an API graph", () => {
    expect(embeddedApiGraph([["workflow", '{"nodes":[],"links":[]}']])).toBeNull();
    expect(embeddedApiGraph([["prompt", "not json"]])).toBeNull();
    expect(embeddedApiGraph([["prompt", '{"1":{"inputs":{}}}']])).toBeNull();
    expect(embeddedApiGraph([])).toBeNull();
  });
});

describe("graphFromPng", () => {
  it("returns the graph of the fixture", () => {
    const result = graphFromPng(fixture());
    expect(result.graph?.["9"]?.class_type).toBe("SaveImage");
    expect("error" in result).toBe(false);
  });

  it("says why there is no graph", () => {
    expect(graphFromPng(new TextEncoder().encode("{}"))).toEqual({
      graph: null,
      error: "PNG 파일이 아닙니다",
    });
    const truncated = fixture().subarray(0, 40);
    expect(graphFromPng(truncated)).toEqual({
      graph: null,
      error: expect.stringMatching(/잘렸습니다/),
    });
  });
});
