import { describe, expect, it } from "vitest";
import {
  MODEL_FAMILIES,
  detectFamily,
  familyById,
  familyProfile,
  isFamilyModelFolder,
  matchArchitecture,
  matchBaseVersion,
} from "./model-families.ts";

/** File names as the model cards and the official ComfyUI templates distribute them. */
const OFFICIAL_FILES: Record<string, string[]> = {
  sd15: ["v1-5-pruned-emaonly-fp16.safetensors", "SD1.5/v1-5-pruned-emaonly.safetensors"],
  sdxl: [
    "sd_xl_base_1.0.safetensors",
    "sd_xl_refiner_1.0.safetensors",
    "sd_xl_turbo_1.0_fp16.safetensors",
    "Illustrious-XL-v1.0.safetensors",
    "noobai-XL-Vpred-1.0.safetensors",
    "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
  ],
  sd3: [
    "sd3.5_large_fp8_scaled.safetensors",
    "sd3.5_medium_incl_clips_t5xxlfp8scaled.safetensors",
    "sd3.5_large_turbo.safetensors",
  ],
  flux1: [
    "flux1-dev.safetensors",
    "flux1-dev-fp8.safetensors",
    "flux1-schnell.safetensors",
    "flux1-dev-kontext_fp8_scaled.safetensors",
    "flux1-krea-dev_fp8_scaled.safetensors",
  ],
  flux2: [
    "flux2_dev_fp8mixed.safetensors",
    "flux-2-klein-base-4b-fp8.safetensors",
    "flux-2-klein-9b-fp8.safetensors",
  ],
  chroma: ["Chroma1-HD.safetensors", "chroma-radiance-x0.safetensors"],
  "qwen-image": [
    "qwen_image_fp8_e4m3fn.safetensors",
    "qwen_image_edit_2509_fp8_e4m3fn.safetensors",
    "Qwen-Image-Lightning-8steps-V1.0.safetensors",
  ],
  "z-image": ["z_image_turbo_bf16.safetensors", "z_image_bf16.safetensors"],
  hidream: ["hidream_i1_full_fp16.safetensors", "hidream_i1_dev_bf16.safetensors"],
  lumina2: [
    "lumina_2.safetensors",
    "lumina_2_model_bf16.safetensors",
    "NetaYumev35_pretrained_all_in_one.safetensors",
  ],
  wan: [
    "wan2.1_t2v_1.3B_fp16.safetensors",
    "wan2.1_i2v_480p_14B_fp16.safetensors",
    "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
    "wan2.2_ti2v_5B_fp16.safetensors",
    "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
  ],
  ltx2: ["ltx-2-19b-dev-fp8.safetensors", "ltx-2-19b-distilled.safetensors"],
  "hunyuan-video": [
    "hunyuan_video_t2v_720p_bf16.safetensors",
    "hunyuanvideo1.5_720p_t2v_fp16.safetensors",
  ],
};

const check = (label: string, values: object) => {
  for (const [k, v] of Object.entries(values))
    if (typeof v === "number") expect(v, `${label}.${k}`).toBeGreaterThan(0);
};

describe("MODEL_FAMILIES", () => {
  it("has unique ids, sources and lowercase identifiers for every family", () => {
    const ids = MODEL_FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(13);
    for (const f of MODEL_FAMILIES) {
      expect(f.sources.length, f.id).toBeGreaterThan(0);
      expect(f.filePatterns.length, f.id).toBeGreaterThan(0);
      expect(f.loaders.length, f.id).toBeGreaterThan(0);
      expect(f.notes, f.id).not.toBe("");
      for (const v of [...f.architectures, ...f.baseVersions, ...f.filePatterns])
        expect(v, f.id).toBe(v.toLowerCase());
      const variantIds = (f.variants ?? []).map((v) => v.id);
      expect(new Set(variantIds).size, f.id).toBe(variantIds.length);
      for (const v of f.variants ?? []) expect(v.filePatterns.length, v.id).toBeGreaterThan(0);
    }
  });

  it("never states a zero or negative number", () => {
    for (const f of MODEL_FAMILIES) {
      check(f.id, f.defaults);
      check(f.id, f.cfgRange ?? {});
      for (const v of f.variants ?? []) {
        check(`${f.id}/${v.id}`, v.defaults ?? {});
        check(`${f.id}/${v.id}`, v.cfgRange ?? {});
      }
    }
  });

  it("covers every family with an official file name, each judged to its own family only", () => {
    expect(Object.keys(OFFICIAL_FILES).toSorted()).toEqual(
      MODEL_FAMILIES.map((f) => f.id).toSorted(),
    );
    for (const [id, files] of Object.entries(OFFICIAL_FILES))
      for (const file of files)
        expect(detectFamily({ file }), file).toEqual({ familyId: id, evidence: "filename" });
  });
});

describe("matchArchitecture", () => {
  it.each([
    ["stable-diffusion-v1", "sd15"],
    ["stable-diffusion-v1/lora", "sd15"],
    ["stable-diffusion-xl-v1-base", "sdxl"],
    ["stable-diffusion-xl-v1-base/lora", "sdxl"],
    ["stable-diffusion-3-5-large", "sd3"],
    ["stable-diffusion-v3-medium", "sd3"],
    ["stable-diffusion-v3.5-large", "sd3"],
    ["flux-1-dev/lora", "flux1"],
    ["Flux.1-dev", "flux1"],
    ["Flux.2-klein-4b", "flux2"],
    ["Chroma1/lora", "chroma"],
    ["Qwen-Image-Edit-Plus", "qwen-image"],
    ["Z-Image", "z-image"],
    ["hidream-i1/lora", "hidream"],
    ["lumina-2", "lumina2"],
    ["wan2.1", "wan"],
    ["hunyuan-video-1.5", "hunyuan-video"],
  ])("%s → %s", (value, id) => {
    expect(matchArchitecture(value)?.id).toBe(id);
  });

  it("leaves architectures of other models alone", () => {
    for (const value of [
      "stable-diffusion-v2-768-v",
      "HiDream-O1-Image",
      "hunyuan-image-2.1",
      "stable-video-diffusion-img2vid-v1",
      "",
    ])
      expect(matchArchitecture(value), value).toBeUndefined();
  });
});

describe("matchBaseVersion", () => {
  it.each([
    ["sd_v1", "sd15"],
    ["sd_1.5", "sd15"],
    ["sdxl_base_v1-0", "sdxl"],
    ["SDXL_1.0", "sdxl"],
    ["flux1", "flux1"],
    ["flux.1_kontext", "flux1"],
    ["flux2_klein_9b", "flux2"],
    ["chroma", "chroma"],
    ["qwen_image", "qwen-image"],
    ["zimage", "z-image"],
    ["hidream_i1", "hidream"],
    ["lumina2", "lumina2"],
    ["wan_2.2_14b", "wan"],
    ["ltx2", "ltx2"],
    ["hunyuan_video_1_5", "hunyuan-video"],
  ])("%s → %s", (value, id) => {
    expect(matchBaseVersion(value)?.id).toBe(id);
  });

  it("does not guess from a spelling it does not know", () => {
    for (const value of ["sd_v2", "medium", "sdxl", "anima", ""])
      expect(matchBaseVersion(value), value).toBeUndefined();
  });
});

describe("detectFamily", () => {
  it("trusts the declaration over metadata and the file name", () => {
    expect(
      detectFamily({
        file: "flux1-dev.safetensors",
        metadata: { "modelspec.architecture": "stable-diffusion-xl-v1-base" },
        declared: "chroma",
      }),
    ).toEqual({ familyId: "chroma", evidence: "declared" });
  });

  it("ignores a declaration the registry no longer has", () => {
    expect(detectFamily({ file: "flux1-dev.safetensors", declared: "gone" })).toEqual({
      familyId: "flux1",
      evidence: "filename",
    });
  });

  it("trusts metadata over the file name, the architecture before the base version", () => {
    expect(
      detectFamily({
        file: "my_style_flux1.safetensors",
        metadata: { ss_base_model_version: "sdxl_base_v1-0" },
      }),
    ).toEqual({ familyId: "sdxl", evidence: "metadata" });
    expect(
      detectFamily({
        file: "style.safetensors",
        metadata: {
          "modelspec.architecture": "flux-1-dev/lora",
          ss_base_model_version: "sdxl_base_v1-0",
        },
      }),
    ).toEqual({ familyId: "flux1", evidence: "metadata" });
  });

  it("falls back to the file name when the metadata names nothing known", () => {
    expect(
      detectFamily({
        file: "loras/wan2.1_style.safetensors",
        metadata: { ss_base_model_version: "something_else" },
      }),
    ).toEqual({ familyId: "wan", evidence: "filename" });
  });

  it("reports a name that fits two families as a conflict", () => {
    expect(detectFamily({ file: "sdxl_to_flux1_style.safetensors" })).toEqual({
      familyId: null,
      evidence: "conflict",
    });
  });

  it("leaves a file nothing identifies unknown", () => {
    for (const file of ["juggernaut_v9.safetensors", "flux-dev.safetensors", "my_lora.safetensors"])
      expect(detectFamily({ file }), file).toEqual({ familyId: null, evidence: "unknown" });
  });
});

describe("familyProfile", () => {
  it("is the family's own rules without a file or a matching variant", () => {
    const profile = familyProfile("flux1", "flux1-dev.safetensors")!;
    expect(profile.name).toBe("FLUX.1");
    expect(profile.variant).toBeUndefined();
    expect(profile.defaults).toEqual(familyById("flux1")!.defaults);
    expect(familyProfile("flux1")!.negative).toBe("zero");
    expect(familyProfile("nope")).toBeUndefined();
    expect(familyProfile(null)).toBeUndefined();
  });

  it("applies the first variant whose pattern fits the file", () => {
    const schnell = familyProfile("flux1", "flux1-schnell-fp8.safetensors")!;
    expect(schnell.name).toBe("FLUX.1 schnell");
    expect(schnell.defaults.steps).toBe(4);
    expect(schnell.defaults.guidance).toBeUndefined();
    expect(schnell.defaults.sampler).toBe("euler");
    expect(schnell.notes).toContain("Step-distilled");
    expect(schnell.notes).toContain(familyById("flux1")!.notes);

    expect(familyProfile("flux2", "flux-2-klein-base-4b.safetensors")!.negative).toBe("text");
    expect(familyProfile("flux2", "flux-2-klein-4b.safetensors")!.negative).toBe("zero");
    expect(familyProfile("flux2", "flux2_dev_fp8mixed.safetensors")!.negative).toBe("none");
  });

  it("picks the variant from the file's own name, not its folders", () => {
    expect(
      familyProfile("qwen-image", "edit/qwen_image_fp8_e4m3fn.safetensors")!.variant,
    ).toBeUndefined();
    expect(
      familyProfile("hidream", "dev/hidream_i1_full_fp16.safetensors")!.variant,
    ).toBeUndefined();
    expect(familyProfile("flux1", "flux/flux1-schnell.safetensors")!.variant?.id).toBe("schnell");
    expect(familyProfile("flux1", "flux\\flux1-schnell.safetensors")!.variant?.id).toBe("schnell");
    // A community repackage with another spelling of the version.
    expect(detectFamily({ file: "Wan2_2-TI2V-5B_fp16.safetensors" }).familyId).toBe("wan");
    expect(familyProfile("wan", "Wan2_2-TI2V-5B_fp16.safetensors")!.grid).toBe(32);
  });

  it("keeps the rules that differ inside a family apart", () => {
    expect(familyProfile("z-image", "z_image_turbo_bf16.safetensors")!.negative).toBe("zero");
    expect(familyProfile("z-image", "z_image_bf16.safetensors")!.negative).toBe("text");
    expect(familyProfile("hidream", "hidream_i1_dev_fp8.safetensors")!.defaults.cfg).toBe(1);
    expect(familyProfile("hidream", "hidream_i1_full_fp8.safetensors")!.defaults.cfg).toBe(5);
    expect(familyProfile("wan", "wan2.2_ti2v_5B_fp16.safetensors")!.grid).toBe(32);
    expect(familyProfile("wan", "wan2.2_i2v_low_noise_14B_fp16.safetensors")!.variant?.id).toBe(
      "wan22",
    );
    expect(familyProfile("wan", "wan2.1_t2v_14B_fp16.safetensors")!.defaults.steps).toBe(30);
    expect(familyProfile("sdxl", "noobai-XL-Vpred-1.0.safetensors")!.samplingNode).toBe(
      "ModelSamplingDiscrete",
    );
    expect(
      familyProfile("hunyuan-video", "hunyuanvideo1.5_720p_i2v_fp16.safetensors")!.negative,
    ).toBe("text");
    expect(familyProfile("ltx2", "ltx-2-19b-dev-fp8.safetensors")!.grid).toBeUndefined();
  });
});

describe("isFamilyModelFolder", () => {
  it("covers base models and LoRAs only", () => {
    expect(isFamilyModelFolder("checkpoints")).toBe(true);
    expect(isFamilyModelFolder("loras")).toBe(true);
    expect(isFamilyModelFolder("vae")).toBe(false);
  });
});
