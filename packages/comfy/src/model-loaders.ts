import type { InputSpec, NodeInfo, ObjectInfo } from "./workflow.ts";

/**
 * Model loader nodes and the model folder each of their file inputs reads from.
 *
 * Comfy Cloud does not list a user's imported models in `/object_info`; its own UI fills these
 * widgets from the asset library (`/api/assets?include_tags=models,<folder>`) instead. The table
 * mirrors the core-loader part of the Cloud frontend's `MODEL_NODE_MAPPINGS`, so the same
 * class/input pairs get the same folders. Pure logic, shared by the server and tests.
 */
export const MODEL_LOADER_FOLDERS: Record<string, Record<string, string>> = {
  CheckpointLoaderSimple: { ckpt_name: "checkpoints" },
  ImageOnlyCheckpointLoader: { ckpt_name: "checkpoints" },
  LoraLoader: { lora_name: "loras" },
  LoraLoaderModelOnly: { lora_name: "loras" },
  VAELoader: { vae_name: "vae" },
  ControlNetLoader: { control_net_name: "controlnet" },
  UNETLoader: { unet_name: "diffusion_models" },
  UpscaleModelLoader: { model_name: "upscale_models" },
  StyleModelLoader: { style_model_name: "style_models" },
  GLIGENLoader: { gligen_name: "gligen" },
  CLIPVisionLoader: { clip_name: "clip_vision" },
  CLIPLoader: { clip_name: "text_encoders" },
  DualCLIPLoader: { clip_name1: "text_encoders", clip_name2: "text_encoders" },
  TripleCLIPLoader: {
    clip_name1: "text_encoders",
    clip_name2: "text_encoders",
    clip_name3: "text_encoders",
  },
  AudioEncoderLoader: { audio_encoder_name: "audio_encoders" },
  ModelPatchLoader: { name: "model_patches" },
  LatentUpscaleModelLoader: { model_name: "latent_upscale_models" },
};

const MODEL_TYPE_TAG = "model_type:";

/**
 * Model folders an asset belongs to, from its tags. Backends with the `model_type:` scheme tag a
 * model `models` + `model_type:<folder>` (one per category); older ones use bare `<folder>` or
 * `<folder>/<sub>` tags. `model_type:` values win when present, as in the Cloud frontend.
 */
export function assetModelFolders(tags: readonly string[]): string[] {
  const typed = tags
    .filter((t) => t.startsWith(MODEL_TYPE_TAG))
    .map((t) => t.slice(MODEL_TYPE_TAG.length));
  const list = typed.some(Boolean)
    ? typed
    : tags
        .filter((t) => t !== "models" && !t.startsWith(MODEL_TYPE_TAG))
        .map((t) => t.split("/")[0]!);
  return [...new Set(list.filter(Boolean))];
}

/** Whether `input` of a `classType` node names a model file (a loader input in the table). */
export function isModelLoaderInput(classType: string | undefined, input: string): boolean {
  return classType !== undefined && MODEL_LOADER_FOLDERS[classType]?.[input] !== undefined;
}

/** Distinct model folders the given node classes load from. */
export function modelFoldersFor(classes: string[]): string[] {
  const out = new Set<string>();
  for (const c of classes) {
    for (const folder of Object.values(MODEL_LOADER_FOLDERS[c] ?? {})) out.add(folder);
  }
  return [...out];
}

function comboOptions(spec: InputSpec): string[] | null {
  const [kind, opts] = spec;
  if (Array.isArray(kind)) return kind.map(String);
  if (kind === "COMBO" && Array.isArray(opts?.options)) return opts.options.map(String);
  return null;
}

function withOptions(spec: InputSpec, options: string[]): InputSpec {
  const [kind, opts] = spec;
  if (Array.isArray(kind)) return [options, opts];
  return [kind, { ...opts, options }];
}

/**
 * `objectInfo` with the asset library's files added to every model loader input: the user's
 * files first (in the library's order), then whatever the node definition listed that the
 * library did not. A loader class missing from `objectInfo` gets a minimal definition, so the
 * field still becomes a select. Folders without a list are left alone. Returns a new object.
 */
export function mergeModelFiles(
  objectInfo: ObjectInfo,
  filesByFolder: ReadonlyMap<string, string[]>,
): ObjectInfo {
  const out: ObjectInfo = { ...objectInfo };
  for (const [classType, inputs] of Object.entries(MODEL_LOADER_FOLDERS)) {
    for (const [input, folder] of Object.entries(inputs)) {
      const files = filesByFolder.get(folder);
      if (!files) continue;
      const info: NodeInfo = structuredClone(out[classType] ?? {});
      const section = input in (info.input?.optional ?? {}) ? "optional" : "required";
      const spec = info.input?.[section]?.[input];
      const existing = spec ? comboOptions(spec) : null;
      // Not a choice input on this server (e.g. a custom node of the same name): leave it.
      if (spec && !existing) continue;
      const merged = [...new Set([...files, ...(existing ?? [])])];
      const next: InputSpec = spec ? withOptions(spec, merged) : [merged, {}];
      info.input = { ...info.input, [section]: { ...info.input?.[section], [input]: next } };
      out[classType] = info;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Distinct model file names an API graph loads: the string value of every model-loader input in
 * the table (checkpoints, UNets, LoRAs, VAEs, ...). Linked inputs (`[nodeId, slot]`) are skipped.
 */
export function graphModelFiles(graph: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== "object") continue;
    const { class_type, inputs } = node as { class_type?: unknown; inputs?: unknown };
    if (typeof class_type !== "string" || !isRecord(inputs)) continue;
    const folders = MODEL_LOADER_FOLDERS[class_type];
    if (!folders) continue;
    for (const input of Object.keys(folders)) {
      const value = inputs[input];
      if (typeof value === "string" && value.trim()) out.add(value);
    }
  }
  return [...out];
}
