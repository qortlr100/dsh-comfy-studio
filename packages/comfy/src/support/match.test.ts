import { describe, expect, it } from "vitest";
import { matchesAnyModel, matchesModelPattern, normalizeModelPatterns } from "./match.ts";
import { graphModelFiles } from "../model-loaders.ts";

describe("matchesModelPattern", () => {
  it("matches a substring case-insensitively", () => {
    expect(matchesModelPattern("flux1-dev", "FLUX/flux1-Dev-fp8.safetensors")).toBe(true);
    expect(matchesModelPattern("sdxl", "flux1-dev.safetensors")).toBe(false);
  });
  it("treats * as a glob over the whole value", () => {
    expect(matchesModelPattern("*sdxl*", "sd_xl_base_1.0.safetensors")).toBe(false);
    expect(matchesModelPattern("*sdxl*", "juggernautXL_sdxl.safetensors")).toBe(true);
    expect(matchesModelPattern("flux1-*.safetensors", "flux1-dev.safetensors")).toBe(true);
    // A glob also covers the bare file name, so subfolders do not break it.
    expect(matchesModelPattern("flux1-*.safetensors", "flux/flux1-dev.safetensors")).toBe(true);
    expect(matchesModelPattern("flux1-*.safetensors", "flux\\flux1-dev.safetensors")).toBe(true);
    expect(matchesModelPattern("*/flux1-*.safetensors", "flux/flux1-dev.safetensors")).toBe(true);
    expect(matchesModelPattern("dev.*", "flux/flux1-dev.safetensors")).toBe(false);
  });
  it("escapes regex characters and ignores empty patterns", () => {
    expect(matchesModelPattern("v1.5", "sd-v1x5.ckpt")).toBe(false);
    expect(matchesModelPattern("v1.5", "sd-v1.5.ckpt")).toBe(true);
    expect(matchesModelPattern("   ", "anything")).toBe(false);
  });
  it("matchesAnyModel is any-of over both lists", () => {
    expect(matchesAnyModel(["sdxl", "flux"], ["a.safetensors", "flux1-dev.safetensors"])).toBe(
      true,
    );
    expect(matchesAnyModel(["sdxl"], ["flux1-dev.safetensors"])).toBe(false);
    expect(matchesAnyModel([], ["flux1-dev.safetensors"])).toBe(false);
  });
});

describe("normalizeModelPatterns", () => {
  it("trims, drops empties and case-insensitive duplicates", () => {
    expect(normalizeModelPatterns([" Flux ", "", "flux", "*sdxl*"])).toEqual(["Flux", "*sdxl*"]);
  });
});

describe("graphModelFiles", () => {
  it("collects the string values of model loader inputs only", () => {
    const graph = {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" },
      },
      "2": {
        class_type: "LoraLoader",
        inputs: { lora_name: "detail.safetensors", model: ["1", 0] },
      },
      "3": { class_type: "UNETLoader", inputs: { unet_name: ["9", 0], weight_dtype: "default" } },
      "4": { class_type: "KSampler", inputs: { sampler_name: "euler", seed: 1 } },
      "5": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "detail.safetensors" } },
    };
    expect(graphModelFiles(graph)).toEqual(["sd_xl_base_1.0.safetensors", "detail.safetensors"]);
  });
});
