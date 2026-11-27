import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ComfyBackend } from "./backend.ts";
import {
  CATALOG_TTL_MS,
  clearNodeCatalogs,
  forgetNodeCatalog,
  describeNodeClass,
  nodeCatalogFor,
  searchNodeClasses,
} from "./node-catalog.ts";
import { standIn } from "./testing/support.ts";
import type { ObjectInfo } from "./workflow.ts";

const CATALOG: ObjectInfo = {
  KSampler: {
    display_name: "KSampler",
    category: "sampling",
    input: {
      required: {
        model: ["MODEL", {}],
        seed: ["INT", { default: 0, min: 0, max: 2 ** 64, control_after_generate: true }],
        steps: ["INT", { default: 20, min: 1, max: 10000 }],
        sampler_name: [["euler", "dpmpp_2m"], {}],
      },
      optional: { note: ["STRING", { multiline: true }] },
    },
    output: ["LATENT"],
    output_name: ["LATENT"],
  },
  LoraLoader: {
    display_name: "Load LoRA",
    category: "loaders",
    description: "LoRAs are used to modify diffusion and CLIP models.",
    input: { required: { lora_name: [["a.safetensors", "b.safetensors", "c.safetensors"], {}] } },
    output: ["MODEL", "CLIP"],
    output_name: ["MODEL", "CLIP"],
  },
  LoraLoaderModelOnly: {
    display_name: "LoraLoaderModelOnly",
    category: "loaders",
    input: { required: {} },
    output: ["MODEL"],
  },
  ImageUpscaleWithModel: {
    display_name: "Upscale Image (using Model)",
    category: "image/upscaling",
    input: { required: { upscale_model: ["UPSCALE_MODEL", {}], image: ["IMAGE", {}] } },
    output: ["IMAGE"],
  },
  SaveImage: {
    display_name: "Save Image",
    category: "image",
    input: { required: { images: ["IMAGE", {}] } },
    output: [],
    output_node: true,
  },
};

function fakeClient(impl: () => Promise<ObjectInfo>): ComfyBackend {
  return standIn<ComfyBackend>({ listNodeClasses: vi.fn(impl) });
}

/** The `vi.fn` behind a fake client's `listNodeClasses`, read without an unbound method reference. */
function listCalls(client: ComfyBackend): Mock {
  return standIn<Mock>(Reflect.get(client, "listNodeClasses"));
}

afterEach(() => clearNodeCatalogs());

describe("nodeCatalogFor", () => {
  const server = { id: "s1", updatedAt: new Date(1_000) };

  it("fetches once per server within the TTL and again after it", async () => {
    const client = fakeClient(async () => CATALOG);
    const t0 = 1_000_000;
    expect(await nodeCatalogFor(server, client, t0)).toBe(CATALOG);
    expect(await nodeCatalogFor(server, client, t0 + CATALOG_TTL_MS - 1)).toBe(CATALOG);
    expect(listCalls(client)).toHaveBeenCalledTimes(1);
    await nodeCatalogFor(server, client, t0 + CATALOG_TTL_MS);
    expect(listCalls(client)).toHaveBeenCalledTimes(2);
  });

  it("refetches when the server row changed, and keeps other servers apart", async () => {
    const client = fakeClient(async () => CATALOG);
    await nodeCatalogFor(server, client, 0);
    await nodeCatalogFor({ id: "s1", updatedAt: new Date(2_000) }, client, 0);
    await nodeCatalogFor({ id: "s2", updatedAt: new Date(1_000) }, client, 0);
    await nodeCatalogFor(server, client, 0); // s1's old entry was dropped by the newer row
    expect(listCalls(client)).toHaveBeenCalledTimes(4);
  });

  it("shares one in-flight fetch and does not keep a failure", async () => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      return CATALOG;
    });
    const first = nodeCatalogFor(server, client, 0);
    const second = nodeCatalogFor(server, client, 0);
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("down");
    expect(await nodeCatalogFor(server, client, 0)).toBe(CATALOG);
    expect(calls).toBe(2);
  });

  it("asks again after a server's catalog is forgotten, leaving other servers cached", async () => {
    const client = fakeClient(async () => CATALOG);
    const other = { id: "s2", updatedAt: new Date(1_000) };
    await nodeCatalogFor(server, client, 0);
    await nodeCatalogFor(other, client, 0);
    forgetNodeCatalog("s1");
    await nodeCatalogFor(server, client, 0);
    await nodeCatalogFor(other, client, 0);
    expect(listCalls(client)).toHaveBeenCalledTimes(3);
  });
});

describe("searchNodeClasses", () => {
  it("ranks exact name, name, display name, then category/description matches", () => {
    expect(searchNodeClasses(CATALOG, "lora").matches.map((m) => m.classType)).toEqual([
      "LoraLoader",
      "LoraLoaderModelOnly",
    ]);
    expect(searchNodeClasses(CATALOG, "LoraLoaderModelOnly").matches[0]!.classType).toBe(
      "LoraLoaderModelOnly",
    );
    expect(searchNodeClasses(CATALOG, "upscale image").matches).toEqual([
      {
        classType: "ImageUpscaleWithModel",
        displayName: "Upscale Image (using Model)",
        category: "image/upscaling",
        outputs: ["IMAGE"],
      },
    ]);
    // Every word must match somewhere; description counts.
    expect(searchNodeClasses(CATALOG, "clip models").matches.map((m) => m.classType)).toEqual([
      "LoraLoader",
    ]);
    expect(searchNodeClasses(CATALOG, "nothing here").total).toBe(0);
    expect(searchNodeClasses(CATALOG, "   ").total).toBe(0);
  });

  it("caps the list but reports the total", () => {
    const result = searchNodeClasses(CATALOG, "image", 1);
    expect(result.total).toBe(2);
    expect(result.matches).toHaveLength(1);
  });
});

describe("describeNodeClass", () => {
  it("lists inputs with their widget type, range and choices, and outputs by index", () => {
    expect(describeNodeClass(CATALOG, "KSampler", 1)).toEqual({
      classType: "KSampler",
      displayName: "KSampler",
      category: "sampling",
      description: null,
      outputNode: false,
      inputs: [
        { name: "model", required: true, type: "MODEL" },
        { name: "seed", required: true, type: "INT", default: 0, min: 0, max: 2 ** 64 },
        { name: "steps", required: true, type: "INT", default: 20, min: 1, max: 10000 },
        { name: "sampler_name", required: true, type: "COMBO", options: ["euler"], optionCount: 2 },
        { name: "note", required: false, type: "STRING", multiline: true },
      ],
      outputs: [{ index: 0, type: "LATENT", name: "LATENT" }],
    });
    expect(describeNodeClass(CATALOG, "SaveImage")).toMatchObject({
      outputNode: true,
      outputs: [],
    });
    expect(describeNodeClass(CATALOG, "LoraLoader")!.inputs[0]!.options).toHaveLength(3);
    expect(describeNodeClass(CATALOG, "Nope")).toBeNull();
  });
});
