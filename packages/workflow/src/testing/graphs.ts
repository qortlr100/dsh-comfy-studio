/**
 * Sample graphs and builders for the tests of the workflow package: a small text-to-image graph, a node catalog that
 * describes it, and a PNG that carries a graph the way ComfyUI writes it.
 *
 * @module @cs/workflow/testing/graphs
 */
import type { ApiGraph, ObjectInfo } from "@cs/comfy/workflow";

/** @returns a fresh text-to-image graph: checkpoint, two prompts, empty latent, sampler, decode and save. */
export function sampleGraph(): ApiGraph {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: 156680208700286,
        steps: 20,
        cfg: 8,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "v1-5.safetensors" } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "a cat", clip: ["4", 1] },
      _meta: { title: "Positive" },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: "blurry", clip: ["4", 1] },
      _meta: { title: "Negative" },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
  };
}

/** @returns the node catalog of a server that has the classes of `sampleGraph` and two checkpoints. */
export function sampleObjectInfo(): ObjectInfo {
  return {
    KSampler: {
      input: {
        required: {
          model: ["MODEL"],
          seed: ["INT", { min: 0, max: 18446744073709552000, control_after_generate: true }],
          steps: ["INT", { min: 1, max: 10000 }],
          cfg: ["FLOAT", { min: 0, max: 100, step: 0.1 }],
          sampler_name: [["euler", "dpmpp_2m"]],
          scheduler: [["normal", "karras"]],
          positive: ["CONDITIONING"],
          negative: ["CONDITIONING"],
          latent_image: ["LATENT"],
          denoise: ["FLOAT", { min: 0, max: 1, step: 0.01 }],
        },
      },
      output: ["LATENT"],
    },
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [["v1-5.safetensors", "sdxl.safetensors"]] } },
      output: ["MODEL", "CLIP", "VAE"],
    },
    EmptyLatentImage: {
      input: {
        required: {
          width: ["INT", { min: 16, max: 16384, step: 8 }],
          height: ["INT", { min: 16, max: 16384, step: 8 }],
          batch_size: ["INT", { min: 1, max: 4096 }],
        },
      },
      output: ["LATENT"],
    },
    CLIPTextEncode: {
      input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP"] } },
      output: ["CONDITIONING"],
    },
    VAEDecode: {
      input: { required: { samples: ["LATENT"], vae: ["VAE"] } },
      output: ["IMAGE"],
    },
    SaveImage: {
      input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } },
      output: [],
      output_node: true,
    },
  };
}

/**
 * @param type - a chunk type.
 * @param data - the chunk's data.
 * @returns the chunk with a correct length and a garbage CRC (the reader ignores CRCs).
 */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  out.set([0xde, 0xad, 0xbe, 0xef], 8 + data.length);
  return out;
}

/**
 * @param text - text of Latin-1 characters.
 * @returns its bytes, one per character.
 */
function latin1(text: string): Uint8Array {
  return Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0) & 0xff));
}

/**
 * @param entries - `tEXt` chunks as [keyword, text]; may be empty.
 * @returns a minimal PNG with those text chunks.
 */
export function pngWithText(entries: Array<[string, string]>): Uint8Array {
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    ...entries.map(([keyword, text]) => chunk("tEXt", latin1(`${keyword}\0${text}`))),
    chunk("IDAT", Uint8Array.from([1, 2, 3])),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * @param graph - an API-format graph.
 * @returns a PNG with the graph in its `prompt` text chunk, as ComfyUI writes its outputs (the graph must be ASCII).
 */
export function pngWithGraph(graph: ApiGraph): Uint8Array {
  return pngWithText([["prompt", JSON.stringify(graph)]]);
}
