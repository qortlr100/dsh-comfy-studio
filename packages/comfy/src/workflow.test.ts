import { describe, expect, it } from "vitest";
import {
  applyParams,
  bindableParams,
  coerceParamValue,
  inferParam,
  listInputCandidates,
  MAX_SEED,
  ParamValueError,
  parseApiGraph,
  randomSeed,
  suggestParams,
  WorkflowFormatError,
  type ApiGraph,
  type WorkflowParam,
  type ObjectInfo,
  rebaseParams,
} from "./workflow.ts";

/** The default txt2img graph as ComfyUI exports it in API format (trimmed). */
const GRAPH: ApiGraph = {
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
  "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
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
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
};

const INFO: ObjectInfo = {
  KSampler: {
    input: {
      required: {
        seed: ["INT", { default: 0, min: 0, max: 2 ** 64, control_after_generate: true }],
        steps: ["INT", { default: 20, min: 1, max: 10000 }],
        cfg: ["FLOAT", { default: 8, min: 0, max: 100, step: 0.1 }],
        sampler_name: [["euler", "dpmpp_2m"], {}],
        scheduler: ["COMBO", { options: ["normal", "karras"] }],
        denoise: ["FLOAT", { default: 1, min: 0, max: 1, step: 0.01 }],
      },
    },
  },
  CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }] } } },
  LoadImage: { input: { required: { image: [["a.png", "b.png"], { image_upload: true }] } } },
};

describe("parseApiGraph", () => {
  it("accepts an API-format graph and the { prompt } wrapper", () => {
    expect(Object.keys(parseApiGraph(GRAPH))).toHaveLength(6);
    expect(Object.keys(parseApiGraph({ prompt: GRAPH }))).toHaveLength(6);
  });
  it("rejects the UI-format export with a hint", () => {
    expect(() => parseApiGraph({ nodes: [], links: [] })).toThrow(/API/);
  });
  it("rejects nodes without class_type and empty graphs", () => {
    expect(() => parseApiGraph({ "1": { inputs: {} } })).toThrow(WorkflowFormatError);
    expect(() => parseApiGraph({})).toThrow(WorkflowFormatError);
    expect(() => parseApiGraph([])).toThrow(WorkflowFormatError);
  });
});

describe("media upload hints", () => {
  it("types LoadAudio / LoadVideo file lists as audio and video fields", () => {
    const audio = inferParam(
      "20",
      { class_type: "LoadAudio", inputs: { audio: "a.wav" } },
      "audio",
      "a.wav",
      {
        input: { required: { audio: [["a.wav"], { audio_upload: true }] } },
      },
    );
    expect(audio).toMatchObject({ type: "audio", default: "a.wav", options: ["a.wav"] });
    const video = inferParam(
      "21",
      { class_type: "LoadVideo", inputs: { file: "v.mp4" } },
      "file",
      "v.mp4",
      {
        input: { required: { file: [["v.mp4"], { video_upload: true }] } },
      },
    );
    expect(video).toMatchObject({ type: "video", default: "v.mp4" });
    expect(() => coerceParamValue(video, "")).toThrow(/파일을 선택/);
  });
});

describe("listInputCandidates / inferParam", () => {
  it("lists literal inputs only, in node order", () => {
    const ids = listInputCandidates(GRAPH).map((c) => c.param.id);
    expect(ids).not.toContain("3.model");
    expect(ids.slice(0, 2)).toEqual(["3.seed", "3.steps"]);
    expect(ids.at(-1)).toBe("9.filename_prefix");
  });
  it("types fields from object_info: combos, seeds, ranges, multiline", () => {
    const byId = new Map(listInputCandidates(GRAPH, INFO).map((c) => [c.param.id, c.param]));
    expect(byId.get("3.seed")).toMatchObject({ type: "seed", max: MAX_SEED });
    expect(byId.get("3.steps")).toMatchObject({ type: "integer", min: 1, max: 10000 });
    expect(byId.get("3.cfg")).toMatchObject({ type: "number", step: 0.1 });
    expect(byId.get("3.sampler_name")).toMatchObject({
      type: "select",
      options: ["euler", "dpmpp_2m"],
    });
    expect(byId.get("3.scheduler")).toMatchObject({
      type: "select",
      options: ["normal", "karras"],
    });
    expect(byId.get("6.text")).toMatchObject({
      type: "text",
      multiline: true,
      label: "Positive · text",
    });
  });
  it("falls back to the value's type without object_info", () => {
    const byId = new Map(listInputCandidates(GRAPH).map((c) => [c.param.id, c.param]));
    expect(byId.get("3.seed")?.type).toBe("seed");
    expect(byId.get("3.cfg")?.type).toBe("integer"); // 8 looks like an integer
    expect(byId.get("3.denoise")?.type).toBe("integer");
    expect(byId.get("3.sampler_name")?.type).toBe("text");
  });
  it("marks LoadImage's upload combo as an image field", () => {
    const node = { class_type: "LoadImage", inputs: { image: "a.png" } };
    expect(inferParam("10", node, "image", "a.png", INFO.LoadImage)).toMatchObject({
      type: "image",
      options: ["a.png", "b.png"],
    });
  });
});

describe("suggestParams", () => {
  it("picks prompts, sampler knobs, size and checkpoint", () => {
    const ids = suggestParams(listInputCandidates(GRAPH, INFO)).map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["3.seed", "3.steps", "4.ckpt_name", "5.width", "6.text", "7.text"]),
    );
    expect(ids).not.toContain("9.filename_prefix");
  });
  it("falls back to text inputs for unknown node types", () => {
    const graph: ApiGraph = { "1": { class_type: "Custom", inputs: { prompt: "x", n: 3 } } };
    expect(suggestParams(listInputCandidates(graph)).map((p) => p.id)).toEqual(["1.prompt"]);
  });
});

describe("applyParams", () => {
  const params = suggestParams(listInputCandidates(GRAPH, INFO));

  it("writes values and defaults into a copy of the graph", () => {
    const out = applyParams(GRAPH, params, { "6.text": "a dog", "3.steps": "30" });
    expect(out["6"]!.inputs.text).toBe("a dog");
    expect(out["3"]!.inputs.steps).toBe(30);
    expect(out["7"]!.inputs.text).toBe("blurry");
    expect(out["3"]!.inputs.model).toEqual(["4", 0]);
    expect(GRAPH["6"]!.inputs.text).toBe("a cat");
  });
  it("ignores unknown ids and never writes links or missing nodes", () => {
    const out = applyParams(GRAPH, params, { "3.model": "x", "99.text": "y" });
    expect(out["3"]!.inputs.model).toEqual(["4", 0]);
    expect(out["99"]).toBeUndefined();
  });
  it("rejects out-of-range and mistyped values", () => {
    expect(() => applyParams(GRAPH, params, { "3.steps": 0 })).toThrow(ParamValueError);
    expect(() => applyParams(GRAPH, params, { "3.steps": 2.5 })).toThrow(ParamValueError);
    expect(() => applyParams(GRAPH, params, { "6.text": 5 })).toThrow(ParamValueError);
    expect(() => applyParams(GRAPH, params, { "3.seed": -1 })).toThrow(ParamValueError);
  });
});

describe("bindableParams", () => {
  it("drops params that point at links, missing inputs, or repeat a binding", () => {
    const [seed] = suggestParams(listInputCandidates(GRAPH, INFO));
    const bogus = { ...seed!, id: "3.model", input: "model" };
    const mismatched = { ...seed!, id: "x" };
    expect(bindableParams(GRAPH, [seed!, seed!, bogus, mismatched])).toEqual([seed]);
  });
});

describe("coerceParamValue", () => {
  it("requires an image name for image fields", () => {
    const p = inferParam(
      "10",
      { class_type: "LoadImage", inputs: {} },
      "image",
      "",
      INFO.LoadImage,
    );
    expect(() => coerceParamValue(p, "")).toThrow(ParamValueError);
    expect(coerceParamValue(p, "sub/a.png")).toBe("sub/a.png");
  });
});

describe("randomSeed", () => {
  it("stays within the safe-integer range", () => {
    for (let i = 0; i < 100; i++) {
      const s = randomSeed();
      expect(Number.isSafeInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("rebaseParams", () => {
  it("takes the patched literal for inputs the patch set, keeps stored defaults elsewhere", () => {
    const template: ApiGraph = {
      "3": { class_type: "KSampler", inputs: { steps: 20, seed: 1, model: ["4", 0] } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
    };
    const params = [
      { id: "3.steps", nodeId: "3", input: "steps", label: "Steps", type: "number", default: 25 },
      { id: "3.seed", nodeId: "3", input: "seed", label: "Seed", type: "seed", default: 1 },
      { id: "6.text", nodeId: "6", input: "text", label: "Prompt", type: "text", default: "a cat" },
    ] as WorkflowParam[];
    const patched: ApiGraph = structuredClone(template);
    patched["6"]!.inputs.text = "a dog";
    patched["3"]!.inputs.seed = ["9", 0];
    const out = rebaseParams(patched, params, new Set(["6.text"]));
    expect(out.map((p) => [p.id, p.default])).toEqual([
      ["3.steps", 25], // stored default survives: the patch left steps alone
      ["6.text", "a dog"],
    ]);
    // Setting an input back to the template's literal is still an explicit choice.
    const back = rebaseParams(template, params, new Set(["3.steps"]));
    expect(back.find((p) => p.id === "3.steps")?.default).toBe(20);
  });
});
