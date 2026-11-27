import { matchesModelPattern } from "./support/match.ts";

/**
 * Model families: what a checkpoint / diffusion model's lineage fixes about a generation — the
 * resolution grid, usual sampling values, whether a negative prompt does anything, the latent
 * and sampling nodes its workflows use, and how its prompts are written. One table drives the
 * agent's workflow context, the graph warnings and preset attachment. Pure logic, shared by the
 * server, the browser and tests.
 *
 * Values come from the model cards and the official ComfyUI example workflows listed in each
 * family's `sources`. A value nobody published is left out, never guessed.
 *
 * The metadata identifiers (`architectures`, `baseVersions`) are the strings the trainers write:
 * the ModelSpec listing (github.com/Stability-AI/ModelSpec), kohya-ss/sd-scripts
 * (`library/sai_model_spec.py`, the `MODEL_VERSION_*` constants), kohya-ss/musubi-tuner
 * (`utils/sai_model_spec.py`, `dataset/architectures.py`), ostris/ai-toolkit (the base model
 * version each model class reports) and Nerogar/OneTrainer (`resources/sd_model_spec/*.json`).
 * Most repackaged base models carry no metadata at all, so the file name is what usually decides.
 */

/** Model folders whose files get a family: base models and the LoRAs trained on them. */
export const FAMILY_MODEL_FOLDERS = ["checkpoints", "diffusion_models", "loras"] as const;
export type FamilyModelFolder = (typeof FAMILY_MODEL_FOLDERS)[number];

export function isFamilyModelFolder(folder: string): folder is FamilyModelFolder {
  return (FAMILY_MODEL_FOLDERS as readonly string[]).includes(folder);
}

/**
 * What the negative prompt does. `text`: it steers the image. `zero`: the family runs at CFG 1
 * (guidance is distilled into the model), so the negative conditioning is ignored and workflows
 * leave it empty or zero it out. `none`: its workflows have no negative conditioning at all.
 */
export type FamilyNegative = "text" | "zero" | "none";

/** How prompts are written: comma-separated tags, natural-language sentences, or either. */
export type FamilyPromptStyle = "tags" | "natural" | "mixed";

/** How ComfyUI loads the base model: an all-in-one checkpoint, or a diffusion model on its own. */
export type FamilyLoader = "checkpoint" | "diffusion";

/** Values of the official example workflow. Anything not published is absent. */
export interface FamilyDefaults {
  width?: number;
  height?: number;
  steps?: number;
  /** The sampler's `cfg`. */
  cfg?: number;
  /** Distilled guidance (`FluxGuidance`), separate from `cfg`. */
  guidance?: number;
  /** ComfyUI sampler id. */
  sampler?: string;
  /** ComfyUI scheduler id. */
  scheduler?: string;
  /** Video families: frame count and frame rate. */
  frames?: number;
  fps?: number;
}

/** Sampler `cfg` values a family is meant to run at, inclusive; a side nobody published is absent. */
export interface CfgRange {
  min?: number;
  max?: number;
}

/** What a family's rules look like once a variant's overrides are applied. */
interface FamilyTraits {
  /**
   * Width and height step of the latent node the family's workflows use (the node rounds other
   * sizes down). Absent when the official workflow itself does not keep to one step.
   */
  grid?: 8 | 16 | 32 | 64;
  defaults: FamilyDefaults;
  cfgRange?: CfgRange;
  negative: FamilyNegative;
  /** Latent node its workflows start from, when not the plain `EmptyLatentImage`. */
  latentNode?: string;
  /** Model-sampling node its workflows patch the model with. */
  samplingNode?: string;
  promptStyle: FamilyPromptStyle;
  /** A few sentences shown to the agent as is (English). */
  notes: string;
}

/**
 * A build of a family whose rules differ (a distilled or turbo release, an edit model, a later
 * version), told apart by file name only. Its values replace the family's; `defaults` are
 * merged key by key (an explicit `undefined` drops the family's value) and `notes` are appended.
 */
export interface FamilyVariant extends Partial<Omit<FamilyTraits, "defaults">> {
  id: string;
  name: string;
  /** Patterns over the file name, in the `modelPatterns` grammar. The first variant that matches wins. */
  filePatterns: string[];
  defaults?: FamilyDefaults;
}

export interface ModelFamily extends FamilyTraits {
  id: string;
  name: string;
  /**
   * Lowercase prefixes of the safetensors `modelspec.architecture` value (ModelSpec) that name
   * the family, as trainers and some official files write it.
   */
  architectures: string[];
  /** Lowercase `ss_base_model_version` values (kohya-style LoRA metadata) that name the family. */
  baseVersions: string[];
  /** File name patterns, in the grammar of a preset's `modelPatterns` (`matchesModelPattern`). */
  filePatterns: string[];
  loaders: FamilyLoader[];
  variants?: FamilyVariant[];
  /** Where the values were read. */
  sources: string[];
}

const TEMPLATES = "https://github.com/Comfy-Org/workflow_templates/blob/main/templates";
const EXAMPLES = "https://comfyanonymous.github.io/ComfyUI_examples";
const DOCS = "https://docs.comfy.org";
const HF = "https://huggingface.co";
/** Latent node definitions (the `step` of width and height) in the ComfyUI source. */
const NODES = "https://github.com/comfyanonymous/ComfyUI/blob/master";

export const MODEL_FAMILIES: readonly ModelFamily[] = [
  {
    id: "sd15",
    name: "Stable Diffusion 1.5",
    architectures: ["stable-diffusion-v1"],
    baseVersions: ["sd_v1", "sd_v1_v", "sd_1.5"],
    filePatterns: ["v1-5-pruned", "sd15", "sd1.5", "sd_1.5", "sd-1.5"],
    loaders: ["checkpoint"],
    grid: 8,
    defaults: { width: 512, height: 512, steps: 20, cfg: 8, sampler: "euler", scheduler: "normal" },
    negative: "text",
    promptStyle: "mixed",
    notes:
      "Trained at 512×512: stay near that size and upscale in a second pass instead of generating large. Short, clear prompts work best.",
    sources: [
      "https://github.com/Comfy-Org/workflow_templates/blob/main/archived/default.json",
      `${HF}/stable-diffusion-v1-5/stable-diffusion-v1-5`,
      `${NODES}/nodes.py`,
    ],
  },
  {
    id: "sdxl",
    name: "SDXL",
    architectures: ["stable-diffusion-xl"],
    baseVersions: ["sdxl_base_v1-0", "sdxl_1.0", "sdxl_"],
    filePatterns: ["sdxl", "sd_xl", "illustrious", "noobai", "*pony*xl*"],
    loaders: ["checkpoint"],
    grid: 8,
    defaults: {
      width: 1024,
      height: 1024,
      steps: 25,
      cfg: 7,
      sampler: "dpmpp_2m",
      scheduler: "karras",
    },
    cfgRange: { max: 10 },
    negative: "text",
    promptStyle: "mixed",
    notes:
      "Trained around one megapixel: 1024×1024, 1152×896, 896×1152, 1216×832, 832×1216, 1344×768, 768×1344.",
    variants: [
      {
        id: "turbo",
        name: "SDXL Turbo",
        filePatterns: ["sd_xl_turbo", "sdxl_turbo", "sdxl-turbo"],
        defaults: {
          width: 512,
          height: 512,
          steps: 1,
          cfg: 1,
          sampler: "euler_ancestral",
          scheduler: undefined,
        },
        cfgRange: { max: 1 },
        negative: "zero",
        notes: "Sampled with SDTurboScheduler + SamplerCustom at 512×512, not a plain KSampler.",
      },
      {
        id: "vpred",
        name: "SDXL v-prediction",
        filePatterns: ["vpred", "v-pred", "v_pred"],
        defaults: { steps: 30, cfg: 5, sampler: "euler", scheduler: "normal" },
        samplingNode: "ModelSamplingDiscrete",
        promptStyle: "tags",
        notes:
          "A v-prediction checkpoint: it needs ModelSamplingDiscrete (sampling v_prediction, zsnr on) between the checkpoint and the sampler, and the euler sampler. NoobAI V-Pred: CFG 4–5, 28–35 steps, prefix `masterpiece, best quality, newest, absurdres, highres`.",
      },
      {
        id: "illustrious",
        name: "Illustrious-XL",
        filePatterns: ["illustrious"],
        defaults: {
          steps: undefined,
          cfg: undefined,
          sampler: "euler_ancestral",
          scheduler: undefined,
        },
        cfgRange: { min: 5, max: 7.5 },
        notes:
          "Danbooru tags, optionally with short natural language; quality tags such as `masterpiece, best quality`. 20–28 steps. v1.0 and later also work up to 1536×1536.",
      },
      {
        id: "noobai",
        name: "NoobAI-XL",
        filePatterns: ["noobai"],
        defaults: {
          steps: undefined,
          cfg: undefined,
          sampler: "euler_ancestral",
          scheduler: undefined,
        },
        cfgRange: { min: 5, max: 6 },
        promptStyle: "tags",
        notes:
          "Danbooru tags in the order subject count, character, series, artist, general tags; prefix `masterpiece, best quality, newest, absurdres, highres`. 25–30 steps; 832×1216 is its best size.",
      },
      {
        id: "pony",
        name: "Pony Diffusion V6 XL",
        filePatterns: ["pony"],
        defaults: { steps: 25, cfg: undefined, sampler: "euler_ancestral", scheduler: undefined },
        notes:
          "Start the prompt with `score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up`, then tags or plain description; add `source_anime` / `rating_safe` style tags as needed. Needs CLIP skip 2 (CLIPSetLastLayer -2). A negative prompt is usually unnecessary.",
      },
    ],
    sources: [
      `${TEMPLATES}/image_sdxl_simple.json`,
      `${TEMPLATES}/sdxl_simple_example.json`,
      `${TEMPLATES}/sdxlturbo_example.json`,
      `${EXAMPLES}/sdxl/`,
      `${HF}/OnomaAIResearch/Illustrious-XL-v1.0`,
      `${HF}/OnomaAIResearch/Illustrious-xl-early-release-v0`,
      `${HF}/Laxhar/noobai-XL-1.1`,
      `${HF}/Laxhar/noobai-XL-Vpred-1.0`,
      "https://civitai.com/models/257749",
      `${NODES}/nodes.py`,
    ],
  },
  {
    id: "sd3",
    name: "Stable Diffusion 3 / 3.5",
    architectures: ["stable-diffusion-3", "stable-diffusion-v3"],
    baseVersions: ["sd_3"],
    filePatterns: ["sd3"],
    loaders: ["checkpoint"],
    grid: 16,
    defaults: {
      width: 1024,
      height: 1024,
      steps: 20,
      cfg: 4.01,
      sampler: "euler",
      scheduler: "sgm_uniform",
    },
    negative: "text",
    latentNode: "EmptySD3LatentImage",
    promptStyle: "natural",
    notes:
      "The official workflows leave the negative prompt empty. `sd3.5_large` / `sd3.5_medium` files carry no text encoders (add TripleCLIPLoader with clip_l, clip_g and t5xxl); the `fp8_scaled` / `incl_clips` files are all-in-one.",
    variants: [
      {
        id: "turbo",
        name: "Stable Diffusion 3.5 Large Turbo",
        filePatterns: ["turbo"],
        defaults: { steps: 4, cfg: 1.2 },
        notes: "Distilled: 4 steps at CFG 1.2.",
      },
    ],
    sources: [
      `${TEMPLATES}/sd3.5_simple_example.json`,
      `${EXAMPLES}/sd3/`,
      "https://blog.comfy.org/sd3-5-comfyui/",
      `${NODES}/comfy_extras/nodes_sd3.py`,
    ],
  },
  {
    id: "flux1",
    name: "FLUX.1",
    architectures: ["flux-1", "flux.1"],
    baseVersions: ["flux1", "flux.1", "flux.1_kontext", "flux_kontext"],
    filePatterns: ["flux1", "flux.1", "flux_1", "flux-1"],
    loaders: ["diffusion", "checkpoint"],
    grid: 16,
    defaults: {
      width: 1024,
      height: 1024,
      steps: 20,
      cfg: 1,
      guidance: 3.5,
      sampler: "euler",
      scheduler: "simple",
    },
    cfgRange: { max: 1 },
    negative: "zero",
    latentNode: "EmptySD3LatentImage",
    promptStyle: "natural",
    notes:
      "Guidance is distilled into the model: keep cfg at 1 and steer with a FluxGuidance node on the positive conditioning (the model card uses 3.5 for dev); the negative prompt is ignored.",
    variants: [
      {
        id: "kontext",
        name: "FLUX.1 Kontext dev",
        filePatterns: ["kontext"],
        defaults: { width: undefined, height: undefined, guidance: 2.5 },
        notes:
          'An image editing model: it needs an input image (FluxKontextImageScale → VAEEncode → ReferenceLatent) instead of an empty latent, and short imperative instructions in English that name the subject ("Change the car color to red").',
      },
      {
        id: "schnell",
        name: "FLUX.1 schnell",
        filePatterns: ["schnell"],
        defaults: { steps: 4, guidance: undefined },
        notes: "Step-distilled: 1–4 steps.",
      },
      {
        id: "krea",
        name: "FLUX.1 Krea dev",
        filePatterns: ["krea"],
        defaults: { guidance: 4.5 },
      },
    ],
    sources: [
      `${TEMPLATES}/flux_dev_full_text_to_image.json`,
      `${TEMPLATES}/flux_schnell.json`,
      `${TEMPLATES}/flux_kontext_dev_basic.json`,
      `${TEMPLATES}/flux1_krea_dev.json`,
      `${DOCS}/tutorials/flux/flux-1-text-to-image`,
      `${DOCS}/tutorials/flux/flux-1-kontext-dev`,
      `${HF}/black-forest-labs/FLUX.1-dev`,
      `${HF}/black-forest-labs/FLUX.1-schnell`,
      `${HF}/black-forest-labs/FLUX.1-Kontext-dev`,
      `${HF}/black-forest-labs/FLUX.1-Krea-dev`,
      `${NODES}/comfy_extras/nodes_sd3.py`,
    ],
  },
  {
    id: "flux2",
    name: "FLUX.2",
    architectures: ["flux.2", "flux-2"],
    baseVersions: [
      "flux2",
      "flux2_klein_4b",
      "flux2_klein_9b",
      "flux_2_dev",
      "flux_2_klein_4b",
      "flux_2_klein_9b",
    ],
    filePatterns: ["flux2", "flux.2", "flux_2", "flux-2"],
    loaders: ["diffusion"],
    grid: 16,
    defaults: { width: 1024, height: 1024, steps: 20, guidance: 4, sampler: "euler" },
    negative: "none",
    latentNode: "EmptyFlux2LatentImage",
    promptStyle: "natural",
    notes:
      "Sampled with SamplerCustomAdvanced + Flux2Scheduler (steps live there), not a KSampler. dev uses BasicGuider — positive conditioning only — with FluxGuidance 4. The text encoder is a single CLIPLoader of type flux2.",
    variants: [
      {
        id: "klein-base",
        name: "FLUX.2 klein (base)",
        filePatterns: ["klein-base", "klein_base"],
        defaults: { cfg: 5, guidance: undefined },
        negative: "text",
        notes: "Runs real CFG: CFGGuider cfg 5 with a negative prompt (empty by default).",
      },
      {
        id: "klein",
        name: "FLUX.2 klein (distilled)",
        filePatterns: ["klein"],
        defaults: { steps: 4, cfg: 1, guidance: undefined },
        cfgRange: { max: 1 },
        negative: "zero",
        notes: "Step-distilled: 4 steps, CFGGuider cfg 1, negative zeroed out.",
      },
    ],
    sources: [
      `${TEMPLATES}/image_flux2_text_to_image.json`,
      `${TEMPLATES}/image_flux2_klein_text_to_image.json`,
      `${DOCS}/tutorials/flux/flux-2-dev`,
      `${DOCS}/tutorials/flux/flux-2-klein`,
      `${DOCS}/built-in-nodes/EmptyFlux2LatentImage`,
      `${HF}/black-forest-labs/FLUX.2-dev`,
      `${HF}/black-forest-labs/FLUX.2-klein-4B`,
    ],
  },
  {
    id: "chroma",
    name: "Chroma",
    architectures: ["chroma"],
    baseVersions: ["chroma"],
    filePatterns: ["chroma"],
    loaders: ["diffusion"],
    grid: 16,
    defaults: {
      width: 1024,
      height: 1024,
      steps: 26,
      cfg: 3.5,
      sampler: "euler",
      scheduler: "beta",
    },
    negative: "text",
    latentNode: "EmptySD3LatentImage",
    samplingNode: "ModelSamplingAuraFlow",
    promptStyle: "natural",
    notes:
      "Derived from FLUX.1 but runs real CFG with a negative prompt (CFGGuider; no FluxGuidance). ModelSamplingAuraFlow shift 1, up to 3 for complex compositions. Text encoder: CLIPLoader of type chroma (T5 only).",
    variants: [
      {
        id: "radiance",
        name: "Chroma Radiance",
        filePatterns: ["radiance"],
        defaults: { steps: 30, scheduler: undefined },
        latentNode: "EmptyChromaRadianceLatentImage",
        notes:
          "A pixel-space model: no VAE (VAELoader set to pixel_space) and its own latent node.",
      },
    ],
    sources: [
      `${TEMPLATES}/image_chroma_text_to_image.json`,
      `${TEMPLATES}/image_chroma1_radiance_text_to_image.json`,
      `${EXAMPLES}/chroma/`,
      `${HF}/lodestones/Chroma1-HD`,
      `${NODES}/comfy_extras/nodes_sd3.py`,
    ],
  },
  {
    id: "qwen-image",
    name: "Qwen-Image",
    architectures: ["qwen-image"],
    baseVersions: ["qwen_image", "qwen_image_edit"],
    filePatterns: ["qwen_image", "qwen-image"],
    loaders: ["diffusion"],
    grid: 16,
    defaults: {
      width: 1328,
      height: 1328,
      steps: 20,
      cfg: 4,
      sampler: "euler",
      scheduler: "simple",
    },
    negative: "text",
    latentNode: "EmptySD3LatentImage",
    samplingNode: "ModelSamplingAuraFlow",
    promptStyle: "natural",
    notes:
      "Prompts in English or Chinese. The model card runs 50 steps at CFG 4; with a Lightning LoRA (4 or 8 steps) run cfg 1, where the negative prompt has no effect. ModelSamplingAuraFlow shift 3.1. Sizes from the model card: 1328×1328, 1664×928, 928×1664, 1584×1056, 1056×1584.",
    variants: [
      {
        id: "edit",
        name: "Qwen-Image-Edit",
        filePatterns: ["edit"],
        defaults: { width: undefined, height: undefined, cfg: 2.5 },
        latentNode: undefined,
        notes:
          "An image editing model: the instruction and the input image go through TextEncodeQwenImageEdit (TextEncodeQwenImageEditPlus for the 2509/2511 releases, which take several images). Downscale oversized inputs first.",
      },
    ],
    sources: [
      `${TEMPLATES}/image_qwen_image.json`,
      `${TEMPLATES}/image_qwen_image_edit.json`,
      `${TEMPLATES}/image_qwen_image_edit_2509.json`,
      `${DOCS}/tutorials/image/qwen/qwen-image`,
      `${HF}/Qwen/Qwen-Image`,
      `${NODES}/comfy_extras/nodes_sd3.py`,
    ],
  },
  {
    id: "z-image",
    name: "Z-Image",
    architectures: ["z-image"],
    baseVersions: ["z_image", "zimage"],
    filePatterns: ["z_image", "z-image", "zimage"],
    loaders: ["diffusion"],
    grid: 16,
    defaults: {
      width: 1024,
      height: 1024,
      steps: 25,
      cfg: 4,
      sampler: "res_multistep",
      scheduler: "simple",
    },
    cfgRange: { min: 3, max: 5 },
    negative: "text",
    latentNode: "EmptySD3LatentImage",
    samplingNode: "ModelSamplingAuraFlow",
    promptStyle: "natural",
    notes:
      "Long descriptive prompts, English or Chinese. ModelSamplingAuraFlow shift 3. Text encoder: CLIPLoader of type lumina2 (qwen_3_4b).",
    variants: [
      {
        id: "turbo",
        name: "Z-Image Turbo",
        filePatterns: ["turbo"],
        defaults: { steps: 8, cfg: 1 },
        cfgRange: { max: 1 },
        negative: "zero",
        notes:
          "Distilled: 8 steps at cfg 1 with no negative prompting (the workflow feeds ConditioningZeroOut to the negative input).",
      },
    ],
    sources: [
      `${TEMPLATES}/image_z_image.json`,
      `${TEMPLATES}/image_z_image_turbo.json`,
      `${DOCS}/tutorials/image/z-image/z-image-turbo`,
      `${HF}/Tongyi-MAI/Z-Image`,
      `${HF}/Tongyi-MAI/Z-Image-Turbo`,
      `${NODES}/comfy_extras/nodes_sd3.py`,
    ],
  },
  {
    id: "hidream",
    name: "HiDream-I1",
    architectures: ["hidream-i1"],
    baseVersions: ["hidream_i1"],
    filePatterns: ["hidream_i1", "hidream-i1"],
    loaders: ["diffusion"],
    grid: 16,
    defaults: {
      width: 1024,
      height: 1024,
      steps: 50,
      cfg: 5,
      sampler: "uni_pc",
      scheduler: "simple",
    },
    negative: "text",
    latentNode: "EmptySD3LatentImage",
    samplingNode: "ModelSamplingSD3",
    promptStyle: "mixed",
    notes:
      "Four text encoders through QuadrupleCLIPLoader (clip_l, clip_g, t5xxl, llama 3.1 8b). ModelSamplingSD3 shift 3.",
    variants: [
      {
        id: "dev",
        name: "HiDream-I1 dev",
        filePatterns: ["dev"],
        defaults: { steps: 28, cfg: 1, sampler: "lcm", scheduler: "normal" },
        cfgRange: { max: 1 },
        negative: "zero",
        notes: "Distilled: cfg 1 (no negative prompt), ModelSamplingSD3 shift 6.",
      },
      {
        id: "fast",
        name: "HiDream-I1 fast",
        filePatterns: ["fast"],
        defaults: { steps: 16, cfg: 1, sampler: "lcm", scheduler: "normal" },
        cfgRange: { max: 1 },
        negative: "zero",
        notes: "Distilled: cfg 1 (no negative prompt), ModelSamplingSD3 shift 3.",
      },
    ],
    sources: [
      `${TEMPLATES}/hidream_i1_full.json`,
      `${TEMPLATES}/hidream_i1_dev.json`,
      `${TEMPLATES}/hidream_i1_fast.json`,
      `${DOCS}/tutorials/image/hidream/hidream-i1`,
      `${NODES}/comfy_extras/nodes_sd3.py`,
    ],
  },
  {
    id: "lumina2",
    name: "Lumina Image 2.0",
    architectures: ["lumina-2"],
    baseVersions: ["lumina2"],
    filePatterns: ["lumina_2", "lumina-2", "lumina2", "neta-lumina", "neta_lumina", "netayume"],
    loaders: ["checkpoint", "diffusion"],
    grid: 16,
    defaults: { width: 1024, height: 1024, steps: 36, cfg: 4 },
    negative: "text",
    latentNode: "EmptySD3LatentImage",
    samplingNode: "ModelSamplingAuraFlow",
    promptStyle: "natural",
    notes:
      "Prompts open with a system prefix that ends in `<Prompt Start>`; keep the one the template has. Official sampling is shift 6 with 36 steps; shift 3 with 20 steps also avoids artifacts.",
    variants: [
      {
        id: "netayume",
        name: "NetaYume Lumina",
        filePatterns: ["neta"],
        defaults: { steps: 30, cfg: 4, sampler: "res_multistep", scheduler: "simple" },
        notes:
          "An anime finetune: ModelSamplingAuraFlow shift 4; best at 1024×1024 (1024×1536 works). Its template prefixes the positive prompt with `You are an assistant designed to generate high quality anime images based on textual prompts. <Prompt Start> ` and the negative with a low-quality counterpart.",
      },
    ],
    sources: [
      "https://blog.comfy.org/p/lumina-image-20-native-support-in",
      `${EXAMPLES}/lumina2/`,
      `${HF}/Alpha-VLLM/Lumina-Image-2.0`,
      `${HF}/Comfy-Org/Lumina_Image_2.0_Repackaged`,
      `${TEMPLATES}/image_netayume_lumina_t2i.json`,
      `${NODES}/comfy_extras/nodes_sd3.py`,
    ],
  },
  {
    id: "wan",
    name: "Wan 2.x",
    architectures: ["wan"],
    baseVersions: ["wan", "wan_2.1", "wan_2.2_14b", "wan_2.2_5b"],
    filePatterns: ["wan2.", "wan2_", "wan21", "wan22"],
    loaders: ["diffusion"],
    grid: 16,
    defaults: {},
    negative: "text",
    latentNode: "EmptyHunyuanLatentVideo",
    samplingNode: "ModelSamplingSD3",
    promptStyle: "natural",
    notes:
      "A video model: the latent node's `length` is the frame count (the templates use 33, 81 and 121) and the frame rate is set where the video is assembled. Image-to-video uses WanImageToVideo instead of an empty latent. The templates' default negative prompt is a Chinese list of artifacts — keep it. Text encoder: CLIPLoader of type wan (umt5_xxl).",
    variants: [
      {
        id: "wan22-5b",
        name: "Wan 2.2 TI2V 5B",
        filePatterns: ["*2.2*5b*", "*2_2*5b*", "*22*5b*"],
        grid: 32,
        defaults: {
          width: 1280,
          height: 704,
          frames: 121,
          fps: 24,
          steps: 20,
          cfg: 5,
          sampler: "uni_pc",
          scheduler: "simple",
        },
        latentNode: "Wan22ImageToVideoLatent",
        notes: "Uses its own VAE (wan2.2_vae) and ModelSamplingSD3 shift 8.",
      },
      {
        id: "wan22",
        name: "Wan 2.2 14B",
        filePatterns: ["wan2.2", "wan2_2", "wan22"],
        defaults: {
          width: 640,
          height: 640,
          frames: 81,
          fps: 16,
          steps: 20,
          cfg: 3.5,
          sampler: "euler",
          scheduler: "simple",
        },
        notes:
          "Two diffusion models run in series — the high-noise file for the first half of the steps, the low-noise file for the rest — each with its own ModelSamplingSD3 (shift 5) and KSamplerAdvanced: change both together. With the lightx2v 4-step LoRAs: 4 steps (2 + 2) at cfg 1.",
      },
      {
        id: "wan21",
        name: "Wan 2.1",
        filePatterns: ["wan2.1", "wan2_1", "wan21"],
        defaults: {
          width: 832,
          height: 480,
          frames: 33,
          fps: 16,
          steps: 30,
          cfg: 6,
          sampler: "uni_pc",
          scheduler: "simple",
        },
        notes:
          "ModelSamplingSD3 shift 8. The 1.3B model is for 480p (832×480); the 14B models also do 720p (1280×720).",
      },
    ],
    sources: [
      `${TEMPLATES}/text_to_video_wan.json`,
      `${TEMPLATES}/image_to_video_wan.json`,
      `${TEMPLATES}/video_wan2_2_14B_t2v.json`,
      `${TEMPLATES}/video_wan2_2_14B_i2v.json`,
      `${TEMPLATES}/video_wan2_2_5B_ti2v.json`,
      `${DOCS}/tutorials/video/wan/wan-video`,
      `${DOCS}/tutorials/video/wan/wan2_2`,
      `${HF}/Wan-AI/Wan2.1-T2V-14B`,
      `${HF}/Wan-AI/Wan2.2-TI2V-5B`,
      `${NODES}/comfy_extras/nodes_hunyuan.py`,
      `${NODES}/comfy_extras/nodes_wan.py`,
    ],
  },
  {
    id: "ltx2",
    name: "LTX-2",
    architectures: [],
    baseVersions: ["ltx2"],
    filePatterns: ["ltx-2", "ltx2", "ltx_2"],
    loaders: ["checkpoint"],
    defaults: {
      width: 1280,
      height: 720,
      frames: 121,
      fps: 24,
      steps: 20,
      cfg: 4,
      sampler: "euler_ancestral",
    },
    negative: "text",
    latentNode: "EmptyLTXVLatentVideo",
    promptStyle: "natural",
    notes:
      "A video model with sound: the latent joins video and audio (LTXVEmptyLatentAudio, LTXVConcatAVLatent) and is sampled in two stages with a spatial upsampler between them, through CFGGuider + SamplerCustomAdvanced + LTXVScheduler rather than a KSampler — edit both stages together. Sizes are silently rounded to the model's step (the template asks for multiples of 64) and the frame count must be 8n+1. Write one flowing paragraph in chronological order, sounds and dialogue included.",
    variants: [
      {
        id: "distilled",
        name: "LTX-2 distilled",
        filePatterns: ["distilled"],
        defaults: { steps: 8, cfg: 1 },
        cfgRange: { max: 1 },
        negative: "zero",
        notes: "Distilled: 8 steps at cfg 1 with an empty negative prompt.",
      },
    ],
    sources: [
      `${TEMPLATES}/video_ltx2_t2v.json`,
      `${TEMPLATES}/video_ltx2_i2v.json`,
      `${TEMPLATES}/video_ltx2_t2v_distilled.json`,
      `${DOCS}/tutorials/video/ltx/ltx-2`,
      `${HF}/Lightricks/LTX-2`,
    ],
  },
  {
    id: "hunyuan-video",
    name: "HunyuanVideo",
    architectures: ["hunyuan-video"],
    baseVersions: ["hunyuan_video", "hunyuan_video_1_5"],
    filePatterns: ["hunyuan_video", "hunyuan-video", "hunyuanvideo"],
    loaders: ["diffusion"],
    grid: 16,
    defaults: {
      width: 848,
      height: 480,
      frames: 73,
      fps: 24,
      steps: 20,
      guidance: 6,
      sampler: "euler",
      scheduler: "simple",
    },
    negative: "none",
    latentNode: "EmptyHunyuanLatentVideo",
    samplingNode: "ModelSamplingSD3",
    promptStyle: "natural",
    notes:
      "A video model sampled with SamplerCustomAdvanced: guidance is a FluxGuidance node (6) and there is no negative conditioning. ModelSamplingSD3 shift 7. Text encoders: DualCLIPLoader of type hunyuan_video (clip_l + llava_llama3). A length of 1 gives a still image.",
    variants: [
      {
        id: "v15",
        name: "HunyuanVideo 1.5",
        filePatterns: ["video1.5", "video15", "video_1.5", "video_15"],
        defaults: { width: 1280, height: 720, frames: 121, cfg: 6, guidance: undefined },
        negative: "text",
        latentNode: "EmptyHunyuanVideo15Latent",
        notes:
          "Runs real CFG (CFGGuider 6) with an optional negative prompt. Text encoders: DualCLIPLoader of type hunyuan_video_15 (qwen_2.5_vl_7b + byt5_small_glyphxl). Image-to-video uses HunyuanVideo15ImageToVideo and a sigclip vision encoder.",
      },
    ],
    sources: [
      `${TEMPLATES}/hunyuan_video_text_to_video.json`,
      `${TEMPLATES}/video_hunyuan_video_1.5_720p_t2v.json`,
      `${EXAMPLES}/hunyuan_video/`,
      `${DOCS}/tutorials/video/hunyuan/hunyuan-video-1-5`,
      `${HF}/tencent/HunyuanVideo`,
      `${HF}/tencent/HunyuanVideo-1.5`,
      `${NODES}/comfy_extras/nodes_hunyuan.py`,
    ],
  },
];

const BY_ID = new Map(MODEL_FAMILIES.map((f) => [f.id, f]));

export function familyById(id: string | null | undefined): ModelFamily | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** The traits a variant replaces outright; `defaults` are merged and `notes` appended instead. */
const VARIANT_OVERRIDES = [
  "grid",
  "cfgRange",
  "negative",
  "latentNode",
  "samplingNode",
  "promptStyle",
] as const;

/** A family's rules for one model file: the family's own, or those of the variant the file name picks. */
export interface FamilyProfile extends FamilyTraits {
  family: ModelFamily;
  variant?: FamilyVariant;
  /** The variant's name when there is one, else the family's. */
  name: string;
}

/**
 * The rules that apply to `file` of family `familyId`. Without a file (or when no variant's
 * pattern fits it) these are the family's own.
 */
export function familyProfile(
  familyId: string | null | undefined,
  file?: string,
): FamilyProfile | undefined {
  const family = familyById(familyId);
  if (!family) return undefined;
  // The file's own name decides: a subfolder called `edit` or `dev` says nothing about the build.
  const baseName = file?.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  const variant = baseName
    ? family.variants?.find((v) => v.filePatterns.some((p) => matchesModelPattern(p, baseName)))
    : undefined;
  const base: FamilyTraits = {
    grid: family.grid,
    defaults: family.defaults,
    cfgRange: family.cfgRange,
    negative: family.negative,
    latentNode: family.latentNode,
    samplingNode: family.samplingNode,
    promptStyle: family.promptStyle,
    notes: family.notes,
  };
  if (!variant) return { ...base, family, name: family.name };
  const traits: Record<string, unknown> = { ...base };
  for (const key of VARIANT_OVERRIDES) if (key in variant) traits[key] = variant[key];
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- traits is `base` (a FamilyTraits) with only keys from VARIANT_OVERRIDES overwritten by the variant's own values
    ...(traits as unknown as FamilyTraits),
    defaults: { ...family.defaults, ...variant.defaults },
    notes: [family.notes, variant.notes].filter(Boolean).join(" "),
    family,
    variant,
    name: variant.name,
  };
}

/**
 * Looks up the rules for a model file a graph loads (`folder` as in `MODEL_LOADER_FOLDERS`):
 * undefined when the file's family is not known. `familyResolver` of `lib/model-meta.service.ts`
 * makes one per server.
 */
export type FamilyResolver = (folder: string, file: string) => FamilyProfile | undefined;

/**
 * The family a `modelspec.architecture` value names: case-insensitive prefix match against
 * `architectures` with the adapter suffix (`…/lora`) dropped, the longest prefix winning.
 */
export function matchArchitecture(value: string): ModelFamily | undefined {
  const v = value.trim().toLowerCase().split("/")[0]!;
  if (!v) return undefined;
  let best: { family: ModelFamily; length: number } | undefined;
  for (const family of MODEL_FAMILIES) {
    for (const prefix of family.architectures) {
      if (v.startsWith(prefix) && (!best || prefix.length > best.length))
        best = { family, length: prefix.length };
    }
  }
  return best?.family;
}

/**
 * The family an `ss_base_model_version` value names. Trainers each write their own spelling
 * (`sdxl_base_v1-0`, `sdxl_1.0`, …), so this is an exact, case-insensitive match against
 * `baseVersions`.
 */
export function matchBaseVersion(value: string): ModelFamily | undefined {
  const v = value.trim().toLowerCase();
  return v ? MODEL_FAMILIES.find((f) => f.baseVersions.includes(v)) : undefined;
}

/** What a scan can conclude on its own. */
export type DetectedEvidence = "metadata" | "filename" | "unknown" | "conflict";
/** What a file's family rests on, the user's own choice included. */
export type FamilyEvidence = DetectedEvidence | "declared";

export interface FamilyDetection {
  familyId: string | null;
  evidence: FamilyEvidence;
}

/** Metadata keys that name a family, in the order they are trusted. */
const METADATA_MATCHERS: readonly [
  key: string,
  match: (value: string) => ModelFamily | undefined,
][] = [
  ["modelspec.architecture", matchArchitecture],
  ["ss_base_model_version", matchBaseVersion],
];

export interface DetectFamilyInput {
  /** File name as a loader input takes it (subfolders included). */
  file: string;
  /** Safetensors `__metadata__` values, when the server could be asked for them. */
  metadata?: Readonly<Record<string, string>> | null;
  /** Family the user picked for this file. */
  declared?: string | null;
}

/**
 * Which family a model file belongs to, without guessing: the user's declaration first, then the
 * file's own metadata, then its name. A name that fits two families is a `conflict`, and a file
 * nothing identifies stays `unknown` — both are shown as they are.
 */
export function detectFamily(input: DetectFamilyInput): FamilyDetection {
  if (familyById(input.declared)) return { familyId: input.declared!, evidence: "declared" };
  for (const [key, match] of METADATA_MATCHERS) {
    const value = input.metadata?.[key];
    const family = value ? match(value) : undefined;
    if (family) return { familyId: family.id, evidence: "metadata" };
  }
  const hits = MODEL_FAMILIES.filter((f) =>
    f.filePatterns.some((p) => matchesModelPattern(p, input.file)),
  );
  if (hits.length === 1) return { familyId: hits[0]!.id, evidence: "filename" };
  return { familyId: null, evidence: hits.length > 1 ? "conflict" : "unknown" };
}
