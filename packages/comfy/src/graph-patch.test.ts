import { describe, expect, it } from "vitest";
import {
  applyGraphPatch,
  formatProblems,
  GraphPatchError,
  graphPatchSchema,
  hasErrors,
  nextNodeId,
  validateGraph,
  type GraphPatch,
  newProblems,
} from "./graph-patch.ts";
import type { FamilyProfile } from "./model-families.ts";
import { standIn } from "./testing/support.ts";
import type { ApiGraph, ObjectInfo } from "./workflow.ts";

/** The default txt2img graph (trimmed), as the template an agent edits. */
const GRAPH: ApiGraph = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 1,
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
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["4", 1] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
};

const CATALOG: ObjectInfo = {
  KSampler: {
    input: {
      required: {
        model: ["MODEL", {}],
        seed: ["INT", { min: 0, max: 2 ** 64 }],
        steps: ["INT", { min: 1, max: 10000 }],
        cfg: ["FLOAT", { min: 0, max: 100 }],
        sampler_name: [["euler", "dpmpp_2m"], {}],
        scheduler: [["normal", "karras"], {}],
        positive: ["CONDITIONING", {}],
        negative: ["CONDITIONING", {}],
        latent_image: ["LATENT", {}],
        denoise: ["FLOAT", { min: 0, max: 1 }],
      },
    },
    output: ["LATENT"],
  },
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["v1-5.safetensors"], {}] } },
    output: ["MODEL", "CLIP", "VAE"],
  },
  EmptyLatentImage: {
    input: {
      required: {
        width: ["INT", { min: 16, max: 16384 }],
        height: ["INT", { min: 16, max: 16384 }],
        batch_size: ["INT", { min: 1, max: 4096 }],
      },
    },
    output: ["LATENT"],
  },
  CLIPTextEncode: {
    input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP", {}] } },
    output: ["CONDITIONING"],
  },
  VAEDecode: {
    input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } },
    output: ["IMAGE"],
  },
  SaveImage: {
    input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] } },
    output: [],
    output_node: true,
  },
  LoraLoader: {
    input: {
      required: {
        model: ["MODEL", {}],
        clip: ["CLIP", {}],
        lora_name: [["detail.safetensors"], {}],
        strength_model: ["FLOAT", { min: -100, max: 100 }],
        strength_clip: ["FLOAT", { min: -100, max: 100 }],
      },
    },
    output: ["MODEL", "CLIP"],
  },
  ImageScaleBy: {
    input: {
      required: {
        image: ["IMAGE", {}],
        upscale_method: [["nearest-exact", "bilinear"], {}],
        scale_by: ["FLOAT", { min: 0.01, max: 8 }],
      },
    },
    output: ["IMAGE"],
  },
  Anything: {
    input: { required: { a: ["*", {}], b: ["COMBO", { options: ["x", "y"] }] } },
    output: ["*"],
  },
};

/** Inserts a LoRA between the checkpoint and the sampler/encoders, as an agent would. */
const LORA_PATCH: GraphPatch = [
  {
    op: "add",
    id: "20",
    class_type: "LoraLoader",
    title: "Detail LoRA",
    inputs: {
      model: { node: "4", output: 0 },
      clip: { node: 4, output: 1 },
      lora_name: "detail.safetensors",
      strength_model: 0.8,
      strength_clip: 0.8,
    },
  },
  { op: "link", node: "3", input: "model", from: { node: "20", output: 0 } },
  { op: "link", node: "6", input: "clip", from: { node: "20", output: 1 } },
  { op: "link", node: "7", input: "clip", from: { node: "20", output: 1 } },
];

function problemsOf(patch: GraphPatch, catalog: ObjectInfo | undefined = CATALOG) {
  const { graph, added } = applyGraphPatch(GRAPH, patch);
  return validateGraph(graph, catalog, { strictNodes: added });
}

const messages = (patch: GraphPatch) => problemsOf(patch).map((p) => p.message);

const familyOf = () => standIn<FamilyProfile>({ name: "Test", grid: 64, negative: "text" });

describe("graphPatchSchema", () => {
  it("accepts the four operations with numeric or string node refs", () => {
    expect(graphPatchSchema.safeParse(LORA_PATCH).success).toBe(true);
    expect(graphPatchSchema.safeParse([{ op: "remove", node: 7 }]).success).toBe(true);
  });

  it("rejects unknown operations, empty patches and tuple links", () => {
    expect(graphPatchSchema.safeParse([{ op: "rename", node: "3" }]).success).toBe(false);
    expect(graphPatchSchema.safeParse([]).success).toBe(false);
    expect(
      graphPatchSchema.safeParse([{ op: "link", node: "3", input: "model", from: ["4", 0] }])
        .success,
    ).toBe(false);
  });
});

describe("applyGraphPatch", () => {
  it("leaves the template untouched and reports added and removed nodes", () => {
    const before = structuredClone(GRAPH);
    const { graph, added, removed } = applyGraphPatch(GRAPH, [
      ...LORA_PATCH,
      { op: "set", node: 3, input: "steps", value: 30 },
      { op: "remove", node: "7" },
    ]);
    expect(GRAPH).toEqual(before);
    expect(added).toEqual(["20"]);
    expect(removed).toEqual(["7"]);
    expect(graph["20"]).toEqual({
      class_type: "LoraLoader",
      _meta: { title: "Detail LoRA" },
      inputs: {
        model: ["4", 0],
        clip: ["4", 1],
        lora_name: "detail.safetensors",
        strength_model: 0.8,
        strength_clip: 0.8,
      },
    });
    expect(graph["3"]!.inputs.model).toEqual(["20", 0]);
    expect(graph["3"]!.inputs.steps).toBe(30);
    expect(graph["7"]).toBeUndefined();
  });

  it("assigns the next free numeric id when add has none", () => {
    expect(nextNodeId(GRAPH)).toBe("10");
    const { added, graph } = applyGraphPatch(GRAPH, [
      { op: "add", class_type: "PreviewImage", inputs: { images: { node: "8", output: 0 } } },
      { op: "add", class_type: "PreviewImage" },
    ]);
    expect(added).toEqual(["10", "11"]);
    expect(graph["11"]!.inputs).toEqual({});
    expect(nextNodeId({ a: { class_type: "X", inputs: {} } })).toBe("1");
  });

  it("turns a link input into a literal with set", () => {
    const { graph } = applyGraphPatch(GRAPH, [
      { op: "set", node: "3", input: "model", value: "not a link" },
    ]);
    expect(graph["3"]!.inputs.model).toBe("not a link");
  });

  it("fails on the first operation with nothing to work on, naming it", () => {
    expect(() =>
      applyGraphPatch(GRAPH, [
        { op: "set", node: "3", input: "steps", value: 25 },
        { op: "set", node: "99", input: "steps", value: 25 },
      ]),
    ).toThrow(new GraphPatchError("노드 99가 없습니다", 1));
    expect(() => applyGraphPatch(GRAPH, [{ op: "remove", node: "99" }])).toThrow(/연산 1: 노드 99/);
    expect(() => applyGraphPatch(GRAPH, [{ op: "add", id: "3", class_type: "KSampler" }])).toThrow(
      /이미 있습니다/,
    );
    expect(() =>
      applyGraphPatch(GRAPH, [
        { op: "link", node: "99", input: "x", from: { node: 1, output: 0 } },
      ]),
    ).toThrow(GraphPatchError);
  });
});

describe("validateGraph", () => {
  it("passes the template and a well-formed LoRA insertion", () => {
    expect(validateGraph(GRAPH, CATALOG)).toEqual([]);
    expect(validateGraph(GRAPH)).toEqual([]);
    expect(problemsOf(LORA_PATCH)).toEqual([]);
  });

  it("rejects a removed node that is still linked to", () => {
    const problems = problemsOf([{ op: "remove", node: "7" }]);
    expect(problems).toEqual([
      {
        nodeId: "3",
        input: "negative",
        message: "링크 대상 노드 7가 없습니다",
        severity: "error",
      },
    ]);
    // Structural: found without a catalog too.
    expect(problemsOf([{ op: "remove", node: "7" }], undefined)).toHaveLength(1);
  });

  it("rejects a graph whose output node is gone, with or without a catalog", () => {
    const patch: GraphPatch = [{ op: "remove", node: "9" }];
    expect(problemsOf(patch).map((p) => p.message)).toEqual([
      "출력 노드(SaveImage 등)가 없어 실행할 수 없습니다",
    ]);
    expect(problemsOf(patch, undefined)).toHaveLength(1);
  });

  it("rejects unknown classes and inputs the class does not declare", () => {
    expect(problemsOf([{ op: "add", class_type: "NoSuchNode" }])).toEqual([
      { nodeId: "10", message: "서버에 없는 노드 클래스입니다: NoSuchNode", severity: "error" },
    ]);
    expect(problemsOf([{ op: "set", node: "3", input: "stepz", value: 1 }])).toEqual([
      {
        nodeId: "3",
        input: "stepz",
        message: "KSampler가 선언하지 않은 입력입니다 (서버가 확인합니다)",
        severity: "warning",
      },
    ]);
  });

  it("checks literal types, ranges and choices", () => {
    expect(messages([{ op: "set", node: "3", input: "steps", value: "20" }])).toEqual([
      '숫자여야 합니다 (받은 값 "20")',
    ]);
    expect(messages([{ op: "set", node: "3", input: "steps", value: 2.5 }])).toEqual([
      "정수여야 합니다 (받은 값 2.5)",
    ]);
    expect(messages([{ op: "set", node: "3", input: "denoise", value: 1.5 }])).toEqual([
      "1 이하여야 합니다",
    ]);
    expect(messages([{ op: "set", node: "3", input: "steps", value: 0 }])).toEqual([
      "1 이상이어야 합니다",
    ]);
    expect(messages([{ op: "set", node: "6", input: "text", value: 3 }])).toEqual([
      "문자열이어야 합니다 (받은 값 3)",
    ]);
    expect(messages([{ op: "set", node: "3", input: "sampler_name", value: "ddim" }])).toEqual([
      '선택지에 없는 값입니다: "ddim"',
    ]);
    expect(messages([{ op: "set", node: "3", input: "model", value: "x" }])).toEqual([
      'MODEL 타입 입력은 링크로 연결해야 합니다 (리터럴 "x")',
    ]);
  });

  it("only warns about a model file the server does not list", () => {
    const problems = problemsOf([
      { op: "set", node: "4", input: "ckpt_name", value: "sdxl.safetensors" },
    ]);
    expect(problems).toEqual([
      {
        nodeId: "4",
        input: "ckpt_name",
        message: '선택지에 없는 값입니다: "sdxl.safetensors"',
        severity: "warning",
      },
    ]);
    expect(hasErrors(problems)).toBe(false);
  });

  it("only warns about an image the server does not list, since uploads outdate the catalog", () => {
    const catalog: ObjectInfo = {
      ...CATALOG,
      LoadImage: {
        input: { required: { image: [["old.png"], { image_upload: true }] } },
        output: ["IMAGE", "MASK"],
      },
    };
    const graph = { ...GRAPH, "10": { class_type: "LoadImage", inputs: { image: "new.png" } } };
    const problems = validateGraph(graph, catalog);
    expect(problems).toEqual([
      expect.objectContaining({ nodeId: "10", input: "image", severity: "warning" }),
    ]);
    expect(hasErrors(problems)).toBe(false);
  });

  it("checks link output index and type, letting wildcards through", () => {
    expect(
      messages([{ op: "link", node: "9", input: "images", from: { node: "3", output: 0 } }]),
    ).toEqual(["images은 IMAGE 입력인데 노드 3 출력 0는 LATENT입니다"]);
    expect(
      messages([{ op: "link", node: "3", input: "model", from: { node: "4", output: 5 } }]),
    ).toEqual(["CheckpointLoaderSimple(노드 4)에는 출력 5가 없습니다 (출력 3개)"]);
    expect(
      messages([
        {
          op: "add",
          class_type: "Anything",
          inputs: { a: { node: "3", output: 0 }, b: "x" },
        },
      ]),
    ).toEqual([]);
    // A `*` output feeds a typed input.
    expect(
      messages([
        { op: "add", id: "30", class_type: "Anything", inputs: { a: 1, b: "y" } },
        { op: "link", node: "9", input: "images", from: { node: "30", output: 0 } },
      ]),
    ).toEqual([]);
  });

  it("requires every required input on added nodes only", () => {
    const problems = problemsOf([
      {
        op: "add",
        class_type: "ImageScaleBy",
        inputs: { image: { node: "8", output: 0 }, upscale_method: "bilinear" },
      },
    ]);
    expect(problems).toEqual([
      {
        nodeId: "10",
        input: "scale_by",
        message: "ImageScaleBy의 필수 입력이 비었습니다",
        severity: "error",
      },
    ]);
    // A template node with the same gap is left to ComfyUI.
    const thin: ApiGraph = { ...GRAPH, "5": { class_type: "EmptyLatentImage", inputs: {} } };
    expect(validateGraph(thin, CATALOG)).toEqual([]);
  });

  it("flags a value that is neither literal nor link", () => {
    const g: ApiGraph = structuredClone(GRAPH);
    g["3"]!.inputs.steps = { nested: true };
    expect(validateGraph(g, CATALOG).map((p) => p.message)).toEqual([
      '값이 리터럴도 링크도 아닙니다: "{\\"nested\\":true}"',
    ]);
  });

  it("formats problems one per line with their location", () => {
    const text = formatProblems([
      { nodeId: "3", input: "steps", message: "정수여야 합니다", severity: "error" },
      { nodeId: "4", input: "ckpt_name", message: "선택지에 없는 값입니다", severity: "warning" },
      { nodeId: "", message: "출력 노드가 없습니다", severity: "error" },
    ]);
    expect(text).toBe(
      "노드 3.steps: 정수여야 합니다\n(경고) 노드 4.ckpt_name: 선택지에 없는 값입니다\n출력 노드가 없습니다",
    );
  });
});

describe("applyGraphPatch bookkeeping", () => {
  it("does not report a node added and removed in the same patch", () => {
    const r = applyGraphPatch(GRAPH, [
      { op: "add", id: "20", class_type: "LoraLoader", inputs: {} },
      { op: "remove", node: "20" },
      { op: "remove", node: "7" },
      { op: "set", node: "3", input: "negative", value: "x" },
    ]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual(["7"]);
    expect(r.graph).not.toHaveProperty("20");
  });

  it("pins every literal the patch writes, including a replacement node's under a template id", () => {
    const r = applyGraphPatch(GRAPH, [
      { op: "set", node: "6", input: "text", value: "a dog" },
      // Set, then linked: no longer a literal the user asked for.
      { op: "set", node: "5", input: "width", value: 768 },
      { op: "link", node: "5", input: "width", from: { node: "21", output: 0 } },
      // The template's sampler replaced under its own id: its steps and seed are the patch's.
      { op: "remove", node: "3" },
      {
        op: "add",
        id: "3",
        class_type: "KSampler",
        inputs: { steps: 30, seed: 7, model: { node: "4", output: 0 } },
      },
      // Added then removed: nothing of it stays pinned.
      { op: "add", id: "22", class_type: "LoraLoader", inputs: { lora_name: "x" } },
      { op: "remove", node: "22" },
    ]);
    expect([...r.pinned].toSorted()).toEqual(["3.seed", "3.steps", "6.text"]);
  });
});

describe("newProblems", () => {
  it("ignores problems the template already had, but reports what the patch introduced", () => {
    // A template node of a class the server lacks, with an undeclared input on a known class.
    const template: ApiGraph = {
      ...GRAPH,
      "30": { class_type: "CustomMath", inputs: { "values.a": 1 } },
      "9": { ...GRAPH["9"]!, inputs: { ...GRAPH["9"]!.inputs, format: "png" } },
    };
    expect(validateGraph(template, CATALOG).some((p) => p.severity === "error")).toBe(true);
    const ok = applyGraphPatch(template, [{ op: "set", node: "3", input: "steps", value: 30 }]);
    expect(newProblems(template, ok.graph, CATALOG, { strictNodes: ok.added })).toEqual([]);
    const bad = applyGraphPatch(template, [{ op: "set", node: "3", input: "steps", value: "x" }]);
    expect(newProblems(template, bad.graph, CATALOG).map((p) => p.input)).toEqual(["steps"]);
  });

  it("passes familyOf to the template validation, so a family warning it had is not new", () => {
    const template: ApiGraph = {
      ...GRAPH,
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } },
    };
    const patched = applyGraphPatch(template, [
      { op: "set", node: "3", input: "steps", value: 30 },
    ]);
    const noisy = (g: ApiGraph) => validateGraph(g, CATALOG, { familyOf }).length;
    expect(newProblems(template, patched.graph, CATALOG, { familyOf })).toEqual(
      newProblems(template, patched.graph, CATALOG),
    );
    expect(noisy(patched.graph)).toBeGreaterThanOrEqual(0);
  });
});
