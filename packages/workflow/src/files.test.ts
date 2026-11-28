/**
 * Tests of the workflow file logic: reading uploads, the canonical form, fields, names, and patches.
 */
import { describe, expect, it } from "vitest";
import type { GraphPatchResult } from "@cs/comfy/graph-patch";
import { workflowParamSchema, type ApiGraph, type WorkflowParam } from "@cs/comfy/workflow";
import { ProjectError } from "@cs/project";
import { standIn } from "@cs/project/testing/support";
import {
  applyPatch,
  canonicalGraph,
  checkDescription,
  checkFields,
  checkName,
  checkPinnedDefaults,
  ellipsize,
  nameFromFile,
  parseGraphFile,
  parsePatch,
  problemLines,
  readGraph,
  suggestedFields,
  trimField,
  variantFields,
} from "./files.ts";
import { pngWithGraph, pngWithText, sampleGraph, sampleObjectInfo } from "./testing/graphs.ts";
import { WORKFLOW_LIMITS } from "./types.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** @returns the error a call throws, or fails the test. */
function thrown(run: () => unknown): ProjectError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error("expected a ProjectError");
}

/** @returns a field of the sample graph by its ID, as `suggestedFields` makes it. */
function field(id: string): WorkflowParam {
  const found = suggestedFields(sampleGraph(), sampleObjectInfo()).find(
    (candidate) => candidate.id === id,
  );
  if (found === undefined) throw new Error(`no field ${id}`);
  return found;
}

describe("parseGraphFile", () => {
  it("reads an API-format JSON file", () => {
    const parsed = parseGraphFile(encode(JSON.stringify(sampleGraph())), "application/json");
    expect(parsed.nodes).toBe(7);
    expect(parsed.graph["3"]?.class_type).toBe("KSampler");
    expect(readGraph(parsed.bytes)).toEqual(parsed.graph);
  });

  it("reads the prompt chunk of a PNG by its signature, whatever the media type says", () => {
    const parsed = parseGraphFile(pngWithGraph(sampleGraph()), "application/octet-stream");
    expect(parsed.nodes).toBe(7);
    expect(parsed.graph["9"]?.class_type).toBe("SaveImage");
  });

  it("refuses a PNG without a graph", () => {
    const error = thrown(() => parseGraphFile(pngWithText([["parameters", "x"]]), "image/png"));
    expect(error.code).toBe("invalid_inputs");
    expect(error.message).not.toBe("");
  });

  it("refuses UI-format JSON and says to export in API format", () => {
    const error = thrown(() =>
      parseGraphFile(encode(JSON.stringify({ nodes: [], links: [] })), "application/json"),
    );
    expect(error.code).toBe("invalid_inputs");
    expect(error.message).toContain("API format");
  });

  it("refuses text that is not JSON and binary that is not UTF-8", () => {
    expect(thrown(() => parseGraphFile(encode("not json"), "text/plain")).code).toBe(
      "invalid_inputs",
    );
    expect(thrown(() => parseGraphFile(Uint8Array.from([0xff, 0xfe, 0x00]), "x")).code).toBe(
      "invalid_inputs",
    );
  });

  it("passes on the message of a graph the library refuses", () => {
    const error = thrown(() => parseGraphFile(encode('{"1":{"inputs":{}}}'), "application/json"));
    expect(error.code).toBe("invalid_inputs");
    expect(error.message).toContain("1");
  });

  it("refuses a file over the size limit", () => {
    const big = new Uint8Array(WORKFLOW_LIMITS.fileBytes + 1);
    const error = thrown(() => parseGraphFile(big, "application/json"));
    expect(error.code).toBe("invalid_inputs");
    expect(error.message).toContain("5 MiB");
  });
});

describe("canonicalGraph", () => {
  it("gives equal bytes for the same graph in another node and key order", () => {
    const graph = sampleGraph();
    const shuffled: ApiGraph = {};
    for (const id of Object.keys(graph).toReversed()) {
      const node = graph[id]!;
      shuffled[id] = {
        ...(node._meta === undefined ? {} : { _meta: node._meta }),
        inputs: Object.fromEntries(Object.entries(node.inputs).toReversed()),
        class_type: node.class_type,
      };
    }
    expect(decode(canonicalGraph(shuffled))).toBe(decode(canonicalGraph(graph)));
  });

  it("is stable through readGraph and sorts nodes by id, numbers first", () => {
    const graph: ApiGraph = {
      b: { class_type: "A", inputs: {} },
      "10": { class_type: "A", inputs: {} },
      "2": { class_type: "A", inputs: { z: 1, a: 2 } },
    };
    const bytes = canonicalGraph(graph);
    expect(Object.keys(JSON.parse(decode(bytes)))).toEqual(["2", "10", "b"]);
    expect(decode(bytes)).toContain('"a": 2,\n      "z": 1');
    expect(canonicalGraph(readGraph(bytes))).toEqual(bytes);
  });

  it("differs when a value differs", () => {
    const changed = sampleGraph();
    changed["6"]!.inputs.text = "a dog";
    expect(canonicalGraph(changed)).not.toEqual(canonicalGraph(sampleGraph()));
  });
});

describe("readGraph", () => {
  it("refuses bytes that are not a graph", () => {
    expect(thrown(() => readGraph(encode("nope"))).code).toBe("invalid_inputs");
    expect(thrown(() => readGraph(encode("[]"))).code).toBe("invalid_inputs");
  });
});

describe("trimField", () => {
  it("drops unknown keys and a long option list but keeps a short one", () => {
    const withExtra = { ...field("3.sampler_name"), junk: 1 };
    const trimmed = trimField(withExtra);
    expect(trimmed).not.toHaveProperty("junk");
    expect(trimmed.options).toEqual(["euler", "dpmpp_2m"]);
    const many = Array.from({ length: WORKFLOW_LIMITS.fieldOptions + 1 }, (_, i) => `m${i}`);
    expect(trimField({ ...field("3.sampler_name"), options: many })).not.toHaveProperty("options");
    const exact = many.slice(0, WORKFLOW_LIMITS.fieldOptions);
    expect(trimField({ ...field("3.sampler_name"), options: exact }).options).toHaveLength(
      WORKFLOW_LIMITS.fieldOptions,
    );
  });
});

describe("suggestedFields", () => {
  it("suggests the usual knobs without a node catalog", () => {
    const ids = suggestedFields(sampleGraph()).map((f) => f.id);
    expect(ids).toContain("3.seed");
    expect(ids).toContain("6.text");
    expect(ids).toContain("4.ckpt_name");
    expect(ids).toContain("5.width");
    expect(ids).not.toContain("9.filename_prefix");
  });

  it("uses the catalog's choices and ranges when there is one", () => {
    const sampler = suggestedFields(sampleGraph(), sampleObjectInfo()).find(
      (f) => f.id === "3.sampler_name",
    );
    expect(sampler?.type).toBe("select");
    expect(sampler?.options).toEqual(["euler", "dpmpp_2m"]);
    const steps = suggestedFields(sampleGraph(), sampleObjectInfo()).find(
      (f) => f.id === "3.steps",
    );
    expect(steps).toMatchObject({ min: 1, max: 10000 });
  });

  it("stores no choices for a field with too many", () => {
    const info = sampleObjectInfo();
    info.CheckpointLoaderSimple!.input!.required!.ckpt_name = [
      Array.from({ length: 80 }, (_, i) => `m${i}.safetensors`),
    ];
    const ckpt = suggestedFields(sampleGraph(), info).find((f) => f.id === "4.ckpt_name");
    expect(ckpt?.type).toBe("select");
    expect(ckpt).not.toHaveProperty("options");
  });

  it("is capped at the field limit", () => {
    const graph: ApiGraph = {};
    for (let i = 1; i <= 150; i += 1) {
      graph[String(i)] = { class_type: "CLIPTextEncode", inputs: { text: `t${i}` } };
    }
    expect(suggestedFields(graph)).toHaveLength(WORKFLOW_LIMITS.fields);
  });
});

describe("checkFields", () => {
  it("accepts fields as suggested and returns them trimmed", () => {
    const fields = suggestedFields(sampleGraph());
    expect(checkFields(sampleGraph(), fields)).toEqual(fields);
    expect(checkFields(sampleGraph(), [])).toEqual([]);
  });

  it("drops unknown keys and coerces the default", () => {
    const edited = { ...field("3.steps"), default: "30", junk: true };
    const [checked] = checkFields(sampleGraph(), [edited]);
    expect(checked?.default).toBe(30);
    expect(checked).not.toHaveProperty("junk");
  });

  it("refuses what is not a list of fields", () => {
    expect(thrown(() => checkFields(sampleGraph(), "x")).code).toBe("invalid_params");
    const error = thrown(() => checkFields(sampleGraph(), [{ id: "3.seed" }]));
    expect(error.code).toBe("invalid_params");
    expect(error.message).toContain("Field 1");
  });

  it("names the field that does not bind", () => {
    const unknownInput = { ...field("3.steps"), id: "3.nope", input: "nope" };
    expect(thrown(() => checkFields(sampleGraph(), [unknownInput])).message).toContain("'3.nope'");
    // A linked input is not a literal.
    const linked = { ...field("3.steps"), id: "3.model", input: "model" };
    expect(thrown(() => checkFields(sampleGraph(), [linked])).message).toContain("'3.model'");
    const wrongId = { ...field("3.steps"), id: "elsewhere" };
    expect(thrown(() => checkFields(sampleGraph(), [wrongId])).message).toContain("'elsewhere'");
  });

  it("refuses a repeated ID", () => {
    const error = thrown(() => checkFields(sampleGraph(), [field("3.steps"), field("3.steps")]));
    expect(error.code).toBe("invalid_params");
    expect(error.message).toContain("'3.steps'");
  });

  it("refuses a default that does not fit the type", () => {
    const error = thrown(() => checkFields(sampleGraph(), [{ ...field("3.steps"), default: "x" }]));
    expect(error.code).toBe("invalid_params");
    expect(error.message).toContain("'3.steps'");
    const tooBig = { ...field("3.steps"), min: 1, max: 10, default: 50 };
    expect(thrown(() => checkFields(sampleGraph(), [tooBig])).message).toContain("'3.steps'");
  });

  it("refuses more than the field limit", () => {
    const many = Array.from({ length: WORKFLOW_LIMITS.fields + 1 }, () => field("3.steps"));
    expect(thrown(() => checkFields(sampleGraph(), many)).message).toContain("at most");
  });
});

describe("names and descriptions", () => {
  it("takes a name from a file name", () => {
    expect(nameFromFile("My flow.v2.json")).toBe("My flow.v2");
    expect(nameFromFile("  spaced  .png")).toBe("spaced");
    expect(nameFromFile("dir/sub\\flow.json")).toBe("flow");
    expect(nameFromFile("noext")).toBe("noext");
    expect(nameFromFile(".json")).toBe("workflow");
    expect(nameFromFile("")).toBe("workflow");
    expect(Array.from(nameFromFile(`${"가".repeat(150)}.json`))).toHaveLength(
      WORKFLOW_LIMITS.nameChars,
    );
  });

  it("checks a name", () => {
    expect(checkName("  a name ")).toBe("a name");
    expect(thrown(() => checkName("   ")).code).toBe("invalid_params");
    expect(thrown(() => checkName(5)).code).toBe("invalid_params");
    expect(thrown(() => checkName("x".repeat(WORKFLOW_LIMITS.nameChars + 1))).code).toBe(
      "invalid_params",
    );
    expect(checkName("x".repeat(WORKFLOW_LIMITS.nameChars))).toHaveLength(
      WORKFLOW_LIMITS.nameChars,
    );
  });

  it("checks a description", () => {
    expect(checkDescription(undefined)).toBe("");
    expect(checkDescription("  hi ")).toBe("hi");
    expect(thrown(() => checkDescription(3)).code).toBe("invalid_params");
    expect(
      thrown(() => checkDescription("x".repeat(WORKFLOW_LIMITS.descriptionChars + 1))).code,
    ).toBe("invalid_params");
  });

  it("cuts text with an ellipsis within the limit", () => {
    expect(ellipsize("short", 10)).toBe("short");
    expect(ellipsize("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("parsePatch and applyPatch", () => {
  it("names where a patch does not parse", () => {
    const error = thrown(() => parsePatch([{ op: "set", node: "3" }]));
    expect(error.code).toBe("invalid_params");
    expect(error.message).toContain("ops.0");
    expect(thrown(() => parsePatch([])).code).toBe("invalid_params");
    expect(thrown(() => parsePatch("x")).code).toBe("invalid_params");
  });

  it("applies a clean patch without problems and leaves the template alone", () => {
    const template = sampleGraph();
    const ops = parsePatch([{ op: "set", node: "6", input: "text", value: "a dog" }]);
    const { result, problems } = applyPatch(template, ops);
    expect(problems).toEqual([]);
    expect(result.graph["6"]?.inputs.text).toBe("a dog");
    expect(template["6"]?.inputs.text).toBe("a cat");
    expect([...result.pinned]).toEqual(["6.text"]);
  });

  it("says which operation does not apply, counting from 1", () => {
    const ops = parsePatch([
      { op: "set", node: "6", input: "text", value: "x" },
      { op: "set", node: "99", input: "text", value: "x" },
    ]);
    const error = thrown(() => applyPatch(sampleGraph(), ops));
    expect(error.code).toBe("invalid_params");
    expect(error.message.startsWith("op 2: ")).toBe(true);
    expect(error.message).not.toContain("연산");
  });

  it("reports a problem when the patch removes the output node", () => {
    const { problems } = applyPatch(sampleGraph(), parsePatch([{ op: "remove", node: "9" }]));
    expect(problems.some((p) => p.severity === "error")).toBe(true);
    expect(problemLines(problems).length).toBe(problems.length);
  });

  it("checks classes against the catalog when there is one", () => {
    const ops = parsePatch([{ op: "add", id: "20", class_type: "NoSuchNode" }]);
    expect(applyPatch(sampleGraph(), ops).problems).toEqual([]);
    const { problems } = applyPatch(sampleGraph(), ops, sampleObjectInfo());
    expect(problems.map((p) => p.nodeId)).toContain("20");
  });
});

/** @returns the parent's fields and the result of a patch on the sample graph. */
function patched(ops: unknown): { parent: WorkflowParam[]; result: GraphPatchResult } {
  return {
    parent: suggestedFields(sampleGraph()),
    result: applyPatch(sampleGraph(), parsePatch(ops)).result,
  };
}

describe("variantFields", () => {
  it("keeps the parent's fields", () => {
    const { parent, result } = patched([{ op: "set", node: "3", input: "steps", value: 20 }]);
    expect(variantFields(parent, result).map((f) => f.id)).toEqual(parent.map((f) => f.id));
  });

  it("gives a pinned field the value the patch set", () => {
    const { parent, result } = patched([{ op: "set", node: "6", input: "text", value: "a dog" }]);
    const fields = variantFields(parent, result);
    expect(fields.find((f) => f.id === "6.text")?.default).toBe("a dog");
    expect(fields.find((f) => f.id === "7.text")?.default).toBe("blurry");
  });

  it("drops a field whose node is removed or whose input became a link", () => {
    const { parent, result } = patched([
      { op: "remove", node: "7" },
      { op: "link", node: "5", input: "width", from: { node: "4", output: 0 } },
    ]);
    const ids = variantFields(parent, result).map((f) => f.id);
    expect(ids).not.toContain("7.text");
    expect(ids).not.toContain("5.width");
    expect(ids).toContain("5.height");
  });

  it("adds the suggested fields of an added node, once", () => {
    const { parent, result } = patched([
      { op: "add", id: "30", class_type: "CLIPTextEncode", inputs: { text: "extra" } },
    ]);
    const fields = variantFields(parent, result);
    expect(fields.at(-1)).toMatchObject({ id: "30.text", default: "extra" });
    expect(fields.filter((f) => f.id === "30.text")).toHaveLength(1);
  });

  it("trims what the parent held and respects the limit", () => {
    const { parent, result } = patched([{ op: "set", node: "3", input: "steps", value: 25 }]);
    const long = parent.map((f) => ({ ...f, options: Array.from({ length: 60 }, String) }));
    expect(variantFields(long, result).every((f) => f.options === undefined)).toBe(true);
  });
});

describe("problemLines", () => {
  it("writes one sentence per problem", () => {
    expect(
      problemLines([
        { nodeId: "3", input: "steps", message: "bad", severity: "error" },
        { nodeId: "4", message: "odd", severity: "warning" },
        { nodeId: "", message: "no output", severity: "error" },
      ]),
    ).toEqual(["node 3.steps: bad", "(warning) node 4: odd", "no output"]);
  });
});

/** @returns whether a field parses with the schema the reducer reads fields with. */
const fits = (candidate: WorkflowParam): boolean =>
  workflowParamSchema.safeParse(candidate).success;

describe("fields that always fit the stored schema", () => {
  it("trims a label, choices and ranges the schema would refuse", () => {
    const base = field("3.sampler_name");
    const trimmed = trimField({
      ...base,
      label: "L".repeat(150),
      options: ["ok", "o".repeat(2000)],
      min: Number.NaN,
      max: Number.POSITIVE_INFINITY,
      step: 0,
    });
    expect(Array.from(trimmed.label)).toHaveLength(100);
    expect(trimmed.label.endsWith("…")).toBe(true);
    expect(trimmed).not.toHaveProperty("options");
    expect(trimmed).not.toHaveProperty("min");
    expect(trimmed).not.toHaveProperty("max");
    expect(trimmed).not.toHaveProperty("step");
    expect(fits(trimmed)).toBe(true);
    expect(trimField({ ...base, step: -2 })).not.toHaveProperty("step");
    expect(trimField({ ...base, step: 0.5 }).step).toBe(0.5);
  });

  it("suggests fields for a node with a very long title", () => {
    const graph = sampleGraph();
    graph["6"] = {
      class_type: "CLIPTextEncode",
      inputs: { text: "a cat", clip: ["4", 1] },
      _meta: { title: "T".repeat(120) },
    };
    const fields = suggestedFields(graph);
    const prompt = fields.find((candidate) => candidate.id === "6.text");
    expect(prompt).toBeDefined();
    expect(fields.every(fits)).toBe(true);
  });

  it("leaves a field out when it cannot be stored even trimmed", () => {
    const graph = sampleGraph();
    graph["6"] = {
      class_type: "CLIPTextEncode",
      inputs: { text: "x".repeat(200_001), clip: ["4", 1] },
    };
    expect(suggestedFields(graph).some((candidate) => candidate.id === "6.text")).toBe(false);
  });

  it("gives a variant's added node with a long title a field that fits", () => {
    const result = applyPatch(sampleGraph(), [
      {
        op: "add",
        id: "20",
        class_type: "EmptyLatentImage",
        title: "L".repeat(150),
        inputs: { width: 64, height: 64, batch_size: 1 },
      },
    ]).result;
    const fields = variantFields(suggestedFields(sampleGraph()), result);
    expect(fields.filter((candidate) => candidate.nodeId === "20").length).toBeGreaterThan(0);
    expect(fields.every(fits)).toBe(true);
  });
});

describe("checkFields on odd and large input", () => {
  it("names a node that is not an own key of the graph, whatever its name", () => {
    for (const nodeId of ["toString", "constructor", "__proto__"]) {
      const odd = { ...field("6.text"), id: `${nodeId}.text`, nodeId };
      expect(thrown(() => checkFields(sampleGraph(), [odd])).message).toContain("is not bound");
    }
    const odd = { ...field("6.text"), id: "6.toString", input: "toString" };
    expect(thrown(() => checkFields(sampleGraph(), [odd])).message).toContain("is not bound");
  });

  it("refuses too many choices and a very long default instead of trimming them", () => {
    const many = Array.from({ length: WORKFLOW_LIMITS.fieldOptions + 1 }, (_, i) => `m${i}`);
    const options = thrown(() =>
      checkFields(sampleGraph(), [{ ...field("3.sampler_name"), options: many }]),
    );
    expect(options.code).toBe("invalid_params");
    expect(options.message).toContain("leave 'options' out");
    const long = "x".repeat(WORKFLOW_LIMITS.fieldDefaultChars + 1);
    const text = thrown(() => checkFields(sampleGraph(), [{ ...field("6.text"), default: long }]));
    expect(text.message).toContain("default is over");
    const exact = "x".repeat(WORKFLOW_LIMITS.fieldDefaultChars);
    expect(checkFields(sampleGraph(), [{ ...field("6.text"), default: exact }])).toHaveLength(1);
  });
});

describe("a patch on a node named like a member of Object.prototype", () => {
  it("is refused as an op error, not thrown as a TypeError", () => {
    for (const node of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      for (const op of [
        { op: "set", node, input: "x", value: 1 },
        { op: "link", node, input: "x", from: { node: "4", output: 0 } },
        { op: "remove", node },
      ]) {
        const error = thrown(() => applyPatch(sampleGraph(), parsePatch([op])));
        expect(error.code).toBe("invalid_params");
        expect(error.message).toBe(`op 1: node ${node} does not exist.`);
      }
    }
  });

  it("counts the op and still allows a node the template does have", () => {
    const graph: ApiGraph = { constructor: { class_type: "SaveImage", inputs: { a: 1 } } };
    const own = applyPatch(
      graph,
      parsePatch([{ op: "set", node: "constructor", input: "a", value: 2 }]),
    );
    expect(own.result.graph["constructor"]?.inputs["a"]).toBe(2);
    const error = thrown(() =>
      applyPatch(
        sampleGraph(),
        parsePatch([
          { op: "set", node: "9", input: "filename_prefix", value: "a" },
          { op: "remove", node: "toString" },
        ]),
      ),
    );
    expect(error.message).toMatch(/^op 2: /);
  });

  it("turns any other error of the library into a refusal", () => {
    // A node without `inputs` is not an API-format graph; the library throws a TypeError on it.
    const broken = standIn<ApiGraph>({ "1": { class_type: "SaveImage" } });
    const error = thrown(() =>
      applyPatch(broken, parsePatch([{ op: "set", node: "1", input: "a", value: 1 }])),
    );
    expect(error).toMatchObject({
      code: "invalid_params",
      message: "op ?: The patch could not be applied.",
    });
  });
});

/** @returns the result of applying one operation to the sample graph. */
const apply = (op: object) => applyPatch(sampleGraph(), parsePatch([op])).result;

describe("checkPinnedDefaults", () => {
  it("refuses a pinned value its field does not take and accepts the rest", () => {
    const fields = suggestedFields(sampleGraph());
    const seed = thrown(() =>
      checkPinnedDefaults(fields, apply({ op: "set", node: "3", input: "seed", value: -1 })),
    );
    expect(seed.code).toBe("invalid_params");
    expect(seed.message).toContain("The patch sets field '3.seed' to a value it does not take: ");
    const text = thrown(() =>
      checkPinnedDefaults(fields, apply({ op: "set", node: "6", input: "text", value: 5 })),
    );
    expect(text.message).toContain("field '6.text'");
    checkPinnedDefaults(fields, apply({ op: "set", node: "3", input: "seed", value: 7 }));
    // A field the patch leaves alone is not checked, even when its stored default would not fit.
    const odd = fields.map((candidate) =>
      candidate.id === "3.seed" ? { ...candidate, default: -1 } : candidate,
    );
    checkPinnedDefaults(odd, apply({ op: "set", node: "9", input: "filename_prefix", value: "a" }));
  });
});

describe("deeply nested JSON", () => {
  it("is refused as a file this app cannot read, not thrown as a RangeError", () => {
    const depth = 200_000;
    const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const file = encode(`{"1":{"class_type":"SaveImage","inputs":{"a":${nested}}}}`);
    const error = thrown(() => parseGraphFile(file, "application/json"));
    expect(error.code).toBe("invalid_inputs");
    expect(error.message).toMatch(/not a graph this app can read|literal|link|valid/i);
  });

  it("is refused by canonicalGraph too", () => {
    const depth = 200_000;
    let value: unknown = [];
    for (let i = 0; i < depth; i += 1) value = [value];
    const graph = standIn<ApiGraph>({ "1": { class_type: "SaveImage", inputs: { a: value } } });
    expect(thrown(() => canonicalGraph(graph)).code).toBe("invalid_inputs");
  });
});
