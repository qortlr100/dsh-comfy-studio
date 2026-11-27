import { describe, expect, it } from "vitest";
import { workflowReadiness } from "./readiness.ts";
import type { ApiGraph, ObjectInfo } from "./workflow.ts";

const GRAPH: ApiGraph = {
  "3": { class_type: "KSampler", inputs: { seed: 1, model: ["10", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
  "10": {
    class_type: "LoraLoader",
    inputs: { model: ["4", 0], clip: ["4", 1], lora_name: "detail.safetensors" },
  },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "out", images: ["3", 0] } },
};

const CATALOG: ObjectInfo = {
  KSampler: { input: { required: { seed: ["INT", {}], model: ["MODEL", {}] } } },
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["sdxl.safetensors", "flux.safetensors"], {}] } },
  },
  LoraLoader: {
    input: {
      required: {
        model: ["MODEL", {}],
        clip: ["CLIP", {}],
        lora_name: ["COMBO", { options: ["detail.safetensors"] }],
      },
    },
  },
  SaveImage: { input: { required: { images: ["IMAGE", {}] } }, output_node: true },
};

describe("workflowReadiness", () => {
  it("is ready when every class and model file is on the server", () => {
    expect(workflowReadiness(GRAPH, CATALOG)).toEqual({
      missingNodes: [],
      missingModels: [],
      unverifiable: [],
      ready: true,
    });
  });

  it("reports node classes the catalog lacks, without checking their inputs", () => {
    const graph: ApiGraph = {
      ...GRAPH,
      "20": { class_type: "UltimateSDUpscale", inputs: { image: ["9", 0] } },
      "21": { class_type: "UNETLoader", inputs: { unet_name: "flux1-dev.safetensors" } },
    };
    const r = workflowReadiness(graph, CATALOG);
    expect(r.missingNodes).toEqual(["UltimateSDUpscale", "UNETLoader"]);
    expect(r.missingModels).toEqual([]);
    expect(r.unverifiable).toEqual([]);
    expect(r.ready).toBe(false);
  });

  it("reports loader files missing from the input's choices, in either combo form", () => {
    const graph: ApiGraph = {
      ...GRAPH,
      "4": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "local-only.safetensors" },
      },
      "10": { ...GRAPH["10"]!, inputs: { ...GRAPH["10"]!.inputs, lora_name: "gone.safetensors" } },
    };
    const r = workflowReadiness(graph, CATALOG);
    expect(r.missingNodes).toEqual([]);
    expect(r.missingModels).toEqual([
      { nodeId: "4", input: "ckpt_name", file: "local-only.safetensors" },
      { nodeId: "10", input: "lora_name", file: "gone.safetensors" },
    ]);
    expect(r.ready).toBe(false);
  });

  it("counts loader inputs without listed choices as unverifiable, still ready", () => {
    const catalog: ObjectInfo = {
      ...CATALOG,
      // A same-named custom node that takes a free string, and a loader listing nothing.
      CheckpointLoaderSimple: { input: { required: { ckpt_name: ["STRING", {}] } } },
      LoraLoader: { input: { required: { model: ["MODEL", {}], lora_name: [[], {}] } } },
    };
    const r = workflowReadiness(GRAPH, catalog);
    expect(r.unverifiable).toEqual([
      { nodeId: "4", input: "ckpt_name", file: "sdxl.safetensors" },
      { nodeId: "10", input: "lora_name", file: "detail.safetensors" },
    ]);
    expect(r.missingModels).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it("skips linked and empty loader inputs and non-loader inputs", () => {
    const graph: ApiGraph = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ["5", 0] } },
      "2": { class_type: "LoraLoader", inputs: { lora_name: "" } },
      "3": { class_type: "KSampler", inputs: { seed: 1 } },
    };
    expect(workflowReadiness(graph, CATALOG)).toEqual({
      missingNodes: [],
      missingModels: [],
      unverifiable: [],
      ready: true,
    });
  });

  it("finds files from the cloud model library merged into the choices", () => {
    const graph: ApiGraph = {
      ...GRAPH,
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "mine.safetensors" } },
    };
    expect(workflowReadiness(graph, CATALOG).ready).toBe(false);
    const library = new Map([["checkpoints", ["mine.safetensors"]]]);
    const r = workflowReadiness(graph, CATALOG, library);
    expect(r.missingModels).toEqual([]);
    expect(r.ready).toBe(true);
    // The library does not invent node classes: a loader the server lacks stays missing.
    const unet: ApiGraph = { "1": { class_type: "UNETLoader", inputs: { unet_name: "f.sft" } } };
    const withUnet = workflowReadiness(unet, CATALOG, new Map([["diffusion_models", ["f.sft"]]]));
    expect(withUnet.missingNodes).toEqual(["UNETLoader"]);
  });
});
