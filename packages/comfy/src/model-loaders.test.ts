import { describe, expect, it } from "vitest";
import {
  assetModelFolders,
  isModelLoaderInput,
  mergeModelFiles,
  modelFoldersFor,
} from "./model-loaders.ts";
import { inferParam, type ObjectInfo } from "./workflow.ts";

describe("modelFoldersFor", () => {
  it("lists the folders of the loader classes in a graph, once each", () => {
    expect(
      modelFoldersFor(["KSampler", "CheckpointLoaderSimple", "LoraLoader", "LoraLoader"]),
    ).toEqual(["checkpoints", "loras"]);
    expect(modelFoldersFor(["KSampler"])).toEqual([]);
  });
});

describe("isModelLoaderInput", () => {
  it("knows the file inputs of loader nodes and nothing else", () => {
    expect(isModelLoaderInput("CheckpointLoaderSimple", "ckpt_name")).toBe(true);
    expect(isModelLoaderInput("LoraLoader", "strength_model")).toBe(false);
    expect(isModelLoaderInput("KSampler", "sampler_name")).toBe(false);
    expect(isModelLoaderInput(undefined, "ckpt_name")).toBe(false);
  });
});

describe("assetModelFolders", () => {
  it("reads model_type tags when present, else bare folder tags by their top segment", () => {
    expect(assetModelFolders(["models", "model_type:checkpoints", "sdxl"])).toEqual([
      "checkpoints",
    ]);
    expect(
      assetModelFolders(["models", "model_type:checkpoints", "model_type:diffusion_models"]),
    ).toEqual(["checkpoints", "diffusion_models"]);
    expect(assetModelFolders(["models", "loras/style", "loras"])).toEqual(["loras"]);
    expect(assetModelFolders(["models", "model_type:"])).toEqual([]);
    expect(assetModelFolders(["models"])).toEqual([]);
  });
});

describe("mergeModelFiles", () => {
  const info: ObjectInfo = {
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [["sd_xl_base.safetensors", "mine.safetensors"], {}] } },
    },
    LoraLoader: {
      input: {
        required: {
          lora_name: ["COMBO", { options: ["detail.safetensors"] }],
          strength_model: ["FLOAT", { default: 1 }],
        },
      },
    },
  };

  it("puts the library's files first and keeps the node's other options", () => {
    const merged = mergeModelFiles(
      info,
      new Map([
        ["checkpoints", ["mine.safetensors", "flux/dev.safetensors"]],
        ["loras", ["style.safetensors"]],
      ]),
    );
    expect(merged.CheckpointLoaderSimple!.input!.required!.ckpt_name).toEqual([
      ["mine.safetensors", "flux/dev.safetensors", "sd_xl_base.safetensors"],
      {},
    ]);
    expect(merged.LoraLoader!.input!.required!.lora_name).toEqual([
      "COMBO",
      { options: ["style.safetensors", "detail.safetensors"] },
    ]);
    // Untouched inputs and the source object stay as they were.
    expect(merged.LoraLoader!.input!.required!.strength_model).toEqual(["FLOAT", { default: 1 }]);
    expect(info.CheckpointLoaderSimple!.input!.required!.ckpt_name![0]).toHaveLength(2);
  });

  it("leaves folders without a list and non-choice inputs alone", () => {
    const custom: ObjectInfo = {
      ...info,
      VAELoader: { input: { required: { vae_name: ["STRING", {}] } } },
    };
    const merged = mergeModelFiles(custom, new Map([["vae", ["ae.safetensors"]]]));
    expect(merged.VAELoader).toEqual(custom.VAELoader);
    expect(merged.CheckpointLoaderSimple).toEqual(custom.CheckpointLoaderSimple);
  });

  it("adds a minimal definition for a loader the server did not describe", () => {
    const merged = mergeModelFiles({}, new Map([["diffusion_models", ["flux1-dev.safetensors"]]]));
    const param = inferParam(
      "1",
      { class_type: "UNETLoader", inputs: { unet_name: "flux1-dev.safetensors" } },
      "unet_name",
      "flux1-dev.safetensors",
      merged.UNETLoader,
    );
    expect(param.type).toBe("select");
    expect(param.options).toEqual(["flux1-dev.safetensors"]);
  });
});
