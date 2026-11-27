import { describe, expect, it } from "vitest";
import { familyWarnings } from "./family-checks.ts";
import { newProblems, validateGraph } from "./graph-patch.ts";
import { familyProfile, type FamilyResolver } from "./model-families.ts";
import type { ApiGraph } from "./workflow.ts";

const FILES: Record<string, [string, string]> = {
  "sdxl.safetensors": ["sdxl", "sdxl.safetensors"],
  "flux1-dev.safetensors": ["flux1", "flux1-dev.safetensors"],
  "z_image_bf16.safetensors": ["z-image", "z_image_bf16.safetensors"],
  "z_image_turbo_bf16.safetensors": ["z-image", "z_image_turbo_bf16.safetensors"],
  "ltx.safetensors": ["ltx2", "ltx.safetensors"],
};
const familyOf: FamilyResolver = (_folder, file) => {
  const hit = FILES[file];
  return hit ? familyProfile(hit[0], hit[1]) : undefined;
};

interface Opts {
  file?: string;
  width?: number;
  height?: number;
  cfg?: number | null;
  negative?: string; // the literal "zero" selects a ConditioningZeroOut negative instead of text
}

/** Checkpoint -> KSampler with an EmptyLatentImage and a negative text encode. */
function ksampler(o: Opts = {}): ApiGraph {
  const g: ApiGraph = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: o.file ?? "sdxl.safetensors" },
    },
    "2": {
      class_type: "EmptyLatentImage",
      inputs: { width: o.width ?? 1024, height: o.height ?? 1024 },
    },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["1", 1] } },
    "5": {
      class_type: o.negative === "zero" ? "ConditioningZeroOut" : "CLIPTextEncode",
      inputs:
        o.negative === "zero"
          ? { conditioning: ["4", 0] }
          : { text: o.negative ?? "", clip: ["1", 1] },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["2", 0],
        ...(o.cfg === null ? {} : { cfg: o.cfg ?? 7 }),
      },
    },
  };
  return g;
}

const resolve = () => familyProfile("flux1", "flux1-dev.safetensors");

const withOutput = (g: ApiGraph): ApiGraph => ({
  ...g,
  "99": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
});

const msgs = (g: ApiGraph) => familyWarnings(g, familyOf).map((p) => `${p.nodeId}.${p.input}`);

describe("familyWarnings on a malformed graph", () => {
  it("treats a link to a prototype key as a missing node instead of throwing", () => {
    for (const target of ["constructor", "__proto__", "toString"]) {
      const graph: ApiGraph = {
        "1": {
          class_type: "KSampler",
          inputs: { model: [target, 0], latent_image: [target, 0], negative: [target, 0], cfg: 1 },
        },
        "9": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
      };
      expect(familyWarnings(graph, resolve)).toEqual([]);
      const problems = validateGraph(graph, undefined, { familyOf: resolve });
      expect(problems.filter((p) => p.severity === "error").map((p) => p.input)).toEqual([
        "model",
        "latent_image",
        "negative",
      ]);
    }
  });
});

describe("familyWarnings", () => {
  it("checks the grid of the latent size", () => {
    const w = familyWarnings(ksampler({ width: 1001 }), familyOf);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ nodeId: "2", input: "width", severity: "warning" });
    expect(w[0]!.message).toContain("8의 배수");
    expect(w[0]!.message).toContain("1001");
    expect(msgs(ksampler({ width: 1000 }))).toEqual([]); // 1000 is a multiple of 8
    expect(msgs(ksampler())).toEqual([]);
  });

  it("warns about a CFG above the family's range", () => {
    const w = familyWarnings(ksampler({ cfg: 12 }), familyOf);
    expect(w.map((p) => `${p.nodeId}.${p.input}`)).toEqual(["3.cfg"]);
    expect(w[0]!.message).toMatch(/10 이하.*12/);
  });

  it("warns about a CFG below Z-Image base range", () => {
    const g = ksampler({ file: "z_image_bf16.safetensors", cfg: 2 });
    const w = familyWarnings(g, familyOf);
    expect(w.map((p) => p.input)).toEqual(["cfg"]);
    expect(w[0]!.message).toContain("3–5");
  });

  it("warns about a negative prompt a cfg 1 family ignores", () => {
    const g = ksampler({ file: "flux1-dev.safetensors", cfg: 1, negative: "blurry" });
    const w = familyWarnings(g, familyOf);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ nodeId: "5", input: "text" });
    expect(w[0]!.message).toContain("네거티브");
  });

  it("stays quiet for an empty or zeroed negative", () => {
    expect(msgs(ksampler({ file: "flux1-dev.safetensors", cfg: 1, negative: "  " }))).toEqual([]);
    expect(msgs(ksampler({ file: "flux1-dev.safetensors", cfg: 1, negative: "zero" }))).toEqual([]);
  });

  it("follows the negative through a pass-through node", () => {
    const g = ksampler({ file: "flux1-dev.safetensors", cfg: 1, negative: "blurry" });
    g["6"] = { class_type: "ConditioningSetTimestepRange", inputs: { conditioning: ["5", 0] } };
    g["3"]!.inputs.negative = ["6", 0];
    expect(msgs(g)).toEqual(["5.text"]);
    // ...and a zero-out behind the pass-through is fine.
    const z = ksampler({ file: "flux1-dev.safetensors", cfg: 1, negative: "zero" });
    z["6"] = { class_type: "ConditioningSetTimestepRange", inputs: { conditioning: ["5", 0] } };
    z["3"]!.inputs.negative = ["6", 0];
    expect(msgs(z)).toEqual([]);
  });

  it("gives only the CFG warning for Flux at cfg 3.5", () => {
    const g = ksampler({ file: "flux1-dev.safetensors", cfg: 3.5, negative: "blurry" });
    expect(msgs(g)).toEqual(["3.cfg"]);
  });

  it("skips a linked or absent cfg", () => {
    const g = ksampler({ file: "flux1-dev.safetensors", cfg: null, negative: "blurry" });
    expect(msgs(g)).toEqual([]);
  });

  it("resolves the model through LoRA loaders", () => {
    const g = ksampler({ width: 1001 });
    g["10"] = { class_type: "LoraLoader", inputs: { lora_name: "a.safetensors", model: ["1", 0] } };
    g["11"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { lora_name: "b.safetensors", model: ["10", 0] },
    };
    g["3"]!.inputs.model = ["11", 0];
    expect(msgs(g)).toEqual(["2.width"]);
  });

  it("resolves a UNETLoader model", () => {
    const g = ksampler({ cfg: 2, negative: "x" });
    g["1"] = { class_type: "UNETLoader", inputs: { unet_name: "z_image_bf16.safetensors" } };
    expect(msgs(g)).toEqual(["3.cfg"]);
  });

  it("handles SamplerCustomAdvanced with a CFGGuider", () => {
    const g = ksampler({ file: "flux1-dev.safetensors", width: 1001, negative: "blurry" });
    g["7"] = {
      class_type: "CFGGuider",
      inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], cfg: 1 },
    };
    g["3"] = {
      class_type: "SamplerCustomAdvanced",
      inputs: { guider: ["7", 0], latent_image: ["2", 0] },
    };
    expect(msgs(g)).toEqual(["2.width", "5.text"]);
    g["7"].inputs.cfg = 4;
    expect(msgs(g)).toEqual(["2.width", "7.cfg"]);
  });

  it("handles SamplerCustomAdvanced with a BasicGuider: only the grid applies", () => {
    const g = ksampler({ file: "flux1-dev.safetensors", height: 1001, negative: "blurry" });
    g["7"] = { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: ["4", 0] } };
    g["3"] = {
      class_type: "SamplerCustomAdvanced",
      inputs: { guider: ["7", 0], latent_image: ["2", 0] },
    };
    expect(msgs(g)).toEqual(["2.height"]);
  });

  it("does nothing for an unknown family, and skips the grid for a family without one", () => {
    expect(msgs(ksampler({ file: "mystery.safetensors", width: 1001, cfg: 99 }))).toEqual([]);
    expect(msgs(ksampler({ file: "ltx.safetensors", width: 1001 }))).toEqual([]);
  });

  it("reports a shared node once and passes through other samplers", () => {
    const g = ksampler({ width: 1001 });
    g["8"] = {
      class_type: "KSamplerAdvanced",
      inputs: { model: ["1", 0], negative: ["5", 0], latent_image: ["3", 0], cfg: 7 },
    };
    expect(msgs(g)).toEqual(["2.width"]);
    g["9"] = {
      class_type: "KSamplerAdvanced",
      inputs: { model: ["1", 0], negative: ["5", 0], latent_image: ["2", 0], cfg: 7 },
    };
    expect(msgs(g)).toEqual(["2.width"]);
  });

  it("survives a cycle in the model chain", () => {
    const g = ksampler({ width: 1001 });
    g["10"] = { class_type: "ModelSamplingSD3", inputs: { model: ["11", 0] } };
    g["11"] = { class_type: "ModelSamplingFlux", inputs: { model: ["10", 0] } };
    g["3"]!.inputs.model = ["10", 0];
    expect(msgs(g)).toEqual([]);
  });
});

describe("validateGraph / newProblems with familyOf", () => {
  it("adds nothing without familyOf", () => {
    const g = withOutput(ksampler({ width: 1001 }));
    expect(validateGraph(g)).toEqual([]);
    expect(validateGraph(g, undefined, { familyOf }).map((p) => p.input)).toEqual(["width"]);
  });

  it("drops a warning the template had and keeps what the patch introduced", () => {
    const template = withOutput(ksampler({ width: 1001 }));
    const same = structuredClone(template);
    expect(newProblems(template, same, undefined, { familyOf })).toEqual([]);
    const patched = structuredClone(template);
    patched["3"]!.inputs.cfg = 12;
    expect(newProblems(template, patched, undefined, { familyOf }).map((p) => p.input)).toEqual([
      "cfg",
    ]);
  });

  it("reports the warning again when the patch swaps the checkpoint to another family", () => {
    const template = withOutput(ksampler({ width: 1001, cfg: 1 }));
    const patched = structuredClone(template);
    patched["1"]!.inputs.ckpt_name = "flux1-dev.safetensors";
    const w = newProblems(template, patched, undefined, { familyOf });
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("16의 배수");
  });
});
