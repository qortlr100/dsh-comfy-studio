/**
 * The plan of a `gen.run` request: the order template, patch, values, seeds; every refusal that needs no server; the
 * pairing of media inputs with fields; and the seeds each run of a batch draws.
 */
import type { ApiGraph, WorkflowParam } from "@cs/comfy/workflow";
import type { AssetId, RecordId } from "@cs/project/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { WorkflowItem } from "@cs/workflow/types";
import { describe, expect, it } from "vitest";
import { graphForRun, mediaKindOf, parseRunParams, planRun } from "./plan.ts";
import { graphWithImage, sampleFields } from "./testing/mount.ts";

/** A workflow over `graph` with `fields`. */
function workflowOf(
  graph: ApiGraph = graphWithImage(),
  fields: WorkflowParam[] = sampleFields(),
): { item: WorkflowItem; graph: ApiGraph } {
  return {
    item: {
      id: brandString<RecordId>("wf-1"),
      name: "Flow",
      description: "",
      graph: brandString<AssetId>("blob"),
      fields,
      parent: null,
      target: null,
      nodes: Object.keys(graph).length,
      created_at: "2026-11-29T00:00:00.000Z",
      updated_at: "2026-11-29T00:00:00.000Z",
    },
    graph,
  };
}

/** The params of a call that names the workflow. */
function paramsOf(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { workflow: "wf-1", ...extra };
}

/** @returns the message of the refusal `planRun` throws. */
function refusal(
  params: Record<string, unknown>,
  mediaCount = 0,
  workflow = workflowOf(),
): { code: string; message: string } {
  try {
    planRun(params, workflow, mediaCount);
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("The plan was not refused.");
}

/** Seeds drawn from 1000 upward, so a test can tell a drawn seed from a given one. */
function counter(): () => number {
  let next = 1000;
  return () => next++;
}

describe("planRun", () => {
  it("builds the template with the fields' defaults, the workflow's name and one run", () => {
    const plan = planRun(paramsOf(), workflowOf(), 0);

    expect(plan.graph).toEqual(graphWithImage());
    expect(plan).toMatchObject({ count: 1, label: "Flow", values: {}, media: [] });
    expect(plan.seedFields.map((field) => field.id)).toEqual(["3.seed"]);
    expect(plan.fixedSeeds).toEqual({});
  });

  it("applies the patch first, then the values over it, and leaves the template unchanged", () => {
    const workflow = workflowOf();
    const plan = planRun(
      paramsOf({
        ops: [
          { op: "set", node: "6", input: "text", value: "from the patch" },
          { op: "set", node: "3", input: "steps", value: 5 },
        ],
        values: { "3.steps": 30 },
      }),
      workflow,
      0,
    );

    expect(plan.graph["6"]?.inputs["text"]).toBe("from the patch");
    expect(plan.graph["3"]?.inputs["steps"]).toBe(30);
    expect(workflow.graph["6"]?.inputs["text"]).toBe("a cat");
  });

  it("takes a value a patch gave a field as the field's default, not the stored default", () => {
    const plan = planRun(
      paramsOf({
        ops: [{ op: "set", node: "3", input: "steps", value: 7 }],
        values: { "6.text": "only the prompt" },
      }),
      workflowOf(),
      0,
    );

    expect(plan.graph["3"]?.inputs["steps"]).toBe(7);
    expect(plan.graph["6"]?.inputs["text"]).toBe("only the prompt");
    expect(plan.values).toEqual({ "6.text": "only the prompt" });
  });

  it("refuses a value for a field the patch removed", () => {
    const graph: ApiGraph = {
      ...graphWithImage(),
      "11": { class_type: "Note", inputs: { text: "x" } },
    };
    const noteField: WorkflowParam = {
      id: "11.text",
      nodeId: "11",
      input: "text",
      label: "Note",
      type: "text",
      default: "x",
    };
    const workflow = workflowOf(graph, [...sampleFields(), noteField]);

    expect(
      planRun(paramsOf({ values: { "11.text": "y" } }), workflow, 0).graph["11"],
    ).toBeDefined();
    const refused = refusal(
      paramsOf({ ops: [{ op: "remove", node: "11" }], values: { "11.text": "y" } }),
      0,
      workflow,
    );

    expect(refused.code).toBe("invalid_params");
    expect(refused.message).toContain("no field '11.text'");
  });

  it("coerces each value and passes on the message with the field ID", () => {
    expect(planRun(paramsOf({ values: { "3.steps": "12" } }), workflowOf(), 0).values).toEqual({
      "3.steps": 12,
    });
    const text = refusal(paramsOf({ values: { "3.steps": "many" } }));
    expect(text.code).toBe("invalid_params");
    expect(text.message).toContain("3.steps");
    expect(refusal(paramsOf({ values: { "3.steps": 0 } })).message).toContain("3.steps");
    expect(refusal(paramsOf({ values: { "6.text": 5 } })).message).toContain("6.text");
  });

  it("refuses a value for a field the workflow does not have, and lists its fields", () => {
    const refused = refusal(paramsOf({ values: { "99.nothing": 1 } }));

    expect(refused.message).toContain("no field '99.nothing'");
    expect(refused.message).toContain("6.text");
  });

  it("refuses a value for a media field: it takes an asset", () => {
    const refused = refusal(paramsOf({ values: { "10.image": "x.png" } }));

    expect(refused.code).toBe("invalid_params");
    expect(refused.message).toContain("inputs.media");
  });

  it("refuses unknown keys, a count outside 1 to 4, and a label over 100 characters", () => {
    expect(refusal(paramsOf({ seed: 1 })).message).toContain("unknown parameter seed");
    expect(refusal({}).code).toBe("invalid_params");
    for (const count of [0, 5, 1.5, -1]) {
      expect(refusal(paramsOf({ count })).message).toContain("'count'");
    }
    expect(refusal(paramsOf({ label: "x".repeat(101) })).message).toContain("'label'");
    expect(planRun(paramsOf({ count: 4 }), workflowOf(), 0).count).toBe(4);
  });

  it("trims the label and falls back to the workflow's name for a blank one", () => {
    expect(planRun(paramsOf({ label: "  fox  " }), workflowOf(), 0).label).toBe("fox");
    expect(planRun(paramsOf({ label: "   " }), workflowOf(), 0).label).toBe("Flow");
  });

  it("refuses a patch that does not apply and one that breaks the graph", () => {
    const missing = refusal(paramsOf({ ops: [{ op: "set", node: "99", input: "x", value: 1 }] }));
    expect(missing).toMatchObject({ code: "invalid_params" });
    expect(missing.message).toContain("op 1");

    const broken = refusal(paramsOf({ ops: [{ op: "remove", node: "6" }] }));
    expect(broken.message).toContain("broken graph");

    expect(refusal(paramsOf({ ops: [] })).message).toContain("Invalid patch");
  });

  it("pairs each media input with the field it fills, in order", () => {
    const plan = planRun(paramsOf({ media_fields: ["10.image", "4.ckpt_name"] }), workflowOf(), 2);

    expect(plan.media).toEqual([
      { node: "10", input: "image", field: "10.image", kind: "image" },
      { node: "4", input: "ckpt_name", field: "4.ckpt_name", kind: null },
    ]);
    // The media fields keep the template's literals; the provider writes the uploaded names.
    expect(plan.graph["10"]?.inputs["image"]).toBe("example.png");
  });

  it("refuses a media field list that does not match the media inputs", () => {
    expect(refusal(paramsOf(), 1).message).toContain("1 media inputs");
    expect(refusal(paramsOf({ media_fields: ["10.image"] }), 0).message).toContain(
      "no media inputs",
    );
    expect(refusal(paramsOf({ media_fields: ["10.image"] }), 2).message).toContain(
      "2 media inputs",
    );
    expect(refusal(paramsOf({ media_fields: ["10.image", "10.image"] }), 2).message).toContain(
      "twice",
    );
  });

  it("refuses a media field that is not a literal input that takes a file name", () => {
    expect(refusal(paramsOf({ media_fields: ["99.image"] }), 1).message).toContain("not a literal");
    expect(refusal(paramsOf({ media_fields: ["3.model"] }), 1).message).toContain("not a literal");
    expect(refusal(paramsOf({ media_fields: ["3.steps"] }), 1).message).toContain("file name");
    expect(
      refusal(paramsOf({ media_fields: ["6.text"], values: { "6.text": "x" } }), 1).message,
    ).toContain("both");
  });

  it("refuses more than 16 media inputs", () => {
    const refused = refusal(paramsOf({ media_fields: [] }), 17);

    expect(refused).toMatchObject({ code: "invalid_inputs" });
  });
});

describe("graphForRun", () => {
  it("keeps a given seed for run 0 and draws anew for later runs", () => {
    const plan = planRun(paramsOf({ values: { "3.seed": 42 } }), workflowOf(), 0);
    const random = counter();

    const first = graphForRun(plan, 0, random);
    const second = graphForRun(plan, 1, random);
    const third = graphForRun(plan, 2, random);

    expect(first.seeds).toEqual({ "3.seed": 42 });
    expect(first.graph["3"]?.inputs["seed"]).toBe(42);
    expect(second.seeds).toEqual({ "3.seed": 1000 });
    expect(third.seeds).toEqual({ "3.seed": 1001 });
    expect(third.graph["3"]?.inputs["seed"]).toBe(1001);
  });

  it("refuses a media field named like a member of Object.prototype with the usual refusal", () => {
    for (const id of ["constructor.image", "__proto__.image", "3.constructor", "toString.name"]) {
      const { code, message } = refusal(paramsOf({ media_fields: [id] }), 1);
      expect(code, id).toBe("invalid_params");
      expect(message, id).toContain("not a literal");
    }
  });

  it("folds a drawn seed into the range a seed field declares", () => {
    const narrow = sampleFields().map((field) =>
      field.id === "3.seed" ? { ...field, min: 0, max: 4_294_967_295, default: 5 } : field,
    );
    const plan = planRun(paramsOf(), workflowOf(graphWithImage(), narrow), 0);
    const drawn = [2 ** 40 + 5, 4_294_967_295, 7];

    const seeds = drawn.map(
      (value, index) => graphForRun(plan, index, () => value).seeds["3.seed"],
    );
    expect(seeds).toEqual([(2 ** 40 + 5) % 2 ** 32, 4_294_967_295, 7]);
  });

  it("draws a seed without a value anew for every run, run 0 included", () => {
    const plan = planRun(paramsOf(), workflowOf(), 0);
    const random = counter();

    expect(graphForRun(plan, 0, random).seeds).toEqual({ "3.seed": 1000 });
    expect(graphForRun(plan, 1, random).seeds).toEqual({ "3.seed": 1001 });
  });

  it("treats a seed the patch pinned as given", () => {
    const plan = planRun(
      paramsOf({ ops: [{ op: "set", node: "3", input: "seed", value: 7 }] }),
      workflowOf(),
      0,
    );
    const random = counter();

    expect(graphForRun(plan, 0, random).seeds).toEqual({ "3.seed": 7 });
    expect(graphForRun(plan, 1, random).seeds).toEqual({ "3.seed": 1000 });
  });

  it("leaves a graph without a seed field as it is and never changes the plan's graph", () => {
    const fields = sampleFields().filter((field) => field.type !== "seed");
    const plan = planRun(paramsOf(), workflowOf(graphWithImage(), fields), 0);

    const run = graphForRun(plan, 0, counter());

    expect(run.seeds).toEqual({});
    expect(run.graph).toEqual(plan.graph);
    expect(run.graph).not.toBe(plan.graph);

    const seeded = planRun(paramsOf(), workflowOf(), 0);
    graphForRun(seeded, 0, counter());
    expect(seeded.graph["3"]?.inputs["seed"]).toBe(156680208700286);
  });

  it("draws with randomSeed by default: whole numbers a seed field accepts", () => {
    const plan = planRun(paramsOf(), workflowOf(), 0);

    const { seeds } = graphForRun(plan, 0);

    expect(Number.isSafeInteger(seeds["3.seed"])).toBe(true);
  });
});

describe("mediaKindOf and parseRunParams", () => {
  it("names the kind of a media field and nothing for other fields", () => {
    const [text, , , image] = sampleFields();
    expect(mediaKindOf(image)).toBe("image");
    expect(mediaKindOf(text)).toBeNull();
    expect(mediaKindOf(undefined)).toBeNull();
    expect(mediaKindOf({ ...sampleFields()[3]!, type: "audio" })).toBe("audio");
  });

  it("reads the params with their defaults", () => {
    expect(parseRunParams({ workflow: "w" })).toEqual({
      workflow: "w",
      values: {},
      ops: undefined,
      mediaFields: [],
      target: undefined,
      count: 1,
      label: undefined,
    });
  });
});
