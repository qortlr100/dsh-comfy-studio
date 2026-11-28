/**
 * Tests of the workflow reducer: each rule of the plan, malformed and unrelated records, and the agent summary.
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it } from "vitest";
import { z as zod } from "zod";
import type { WorkflowParam } from "@cs/comfy/workflow";
import type { AssetId, ProjectId, ProjectRecord, RecordId, SessionId } from "@cs/project/types";
import { emptySlice, workflowReducer } from "./reducer.ts";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_OPERATIONS,
  type WorkflowItem,
  type WorkflowSlice,
  type WorkflowTarget,
} from "./types.ts";

const rid = (text: string): RecordId => brandString<RecordId>(text);

/** @returns the ISO time `seconds` after a fixed start. */
function at(seconds: number): string {
  return new Date(Date.parse("2026-02-01T00:00:00.000Z") + seconds * 1000).toISOString();
}

const STEPS: WorkflowParam = {
  id: "3.steps",
  nodeId: "3",
  input: "steps",
  label: "steps",
  type: "integer",
  default: 20,
};
const TEXT: WorkflowParam = {
  id: "6.text",
  nodeId: "6",
  input: "text",
  label: "text",
  type: "text",
  default: "a cat",
};
const TARGET: WorkflowTarget = { provider: "comfy", target: "main" };

/** What a test says about one record. */
interface Spec {
  id: string;
  operation: string;
  time: number;
  params?: Record<string, unknown>;
  report?: Record<string, unknown> | null;
  status?: ProjectRecord["status"];
}

/** @returns the record a spec describes. */
function record(spec: Spec): ProjectRecord {
  const base: ProjectRecord = {
    id: rid(spec.id),
    parents: [],
    kind: "operation",
    component: spec.operation.split(".")[0] ?? "workflow",
    operation: spec.operation,
    operation_version: "1",
    actor: "user",
    surface: "view",
    turn: null,
    session: brandString<SessionId>("s"),
    tool_call: null,
    intent: "test",
    params: spec.params ?? {},
    inputs: [],
    outputs: [],
    based_on: null,
    supersedes: [],
    deterministic: false,
    status: spec.status ?? "done",
    created_at: at(spec.time),
  };
  return spec.report === null || spec.report === undefined
    ? base
    : { ...base, report: spec.report };
}

/** @returns the report of a record that makes a workflow. */
function made(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    graph: `graph-${name}`,
    fields: [STEPS, TEXT],
    nodes: 7,
    name,
    description: `About ${name}`,
    ...extra,
  };
}

/** @returns the slice after the records. */
function fold(...records: ProjectRecord[]): WorkflowSlice {
  let slice = workflowReducer.initial();
  for (const next of records) slice = workflowReducer.reduce(slice, next);
  return slice ?? emptySlice();
}

/** @returns a record that creates a workflow. */
function create(
  id: string,
  time: number,
  name = id,
  params: Record<string, unknown> = {},
): ProjectRecord {
  return record({ id, operation: WORKFLOW_OPERATIONS.create, time, params, report: made(name) });
}

/** @returns a workflow of the slice, or fails. */
function itemOf(slice: WorkflowSlice, id: string): WorkflowItem {
  const found = slice.items[rid(id)];
  if (found === undefined) throw new Error(`no workflow ${id}`);
  return found;
}

const base = (): ProjectRecord => create("w1", 1, "Base", { target: TARGET });
const update = (params: Record<string, unknown>, report?: Record<string, unknown>): ProjectRecord =>
  record({
    id: "u1",
    operation: WORKFLOW_OPERATIONS.update,
    time: 9,
    params: { workflow: "w1", ...params },
    ...(report === undefined ? {} : { report }),
  });

const remove = (id: string, time: number): ProjectRecord =>
  record({
    id: `d-${id}`,
    operation: WORKFLOW_OPERATIONS.delete,
    time,
    params: { workflow: id },
  });
const variant = (id: string, parent: string, time: number): ProjectRecord =>
  record({
    id,
    operation: WORKFLOW_OPERATIONS.saveVariant,
    time,
    params: { workflow: parent },
    report: made(id),
  });

const summaryShape = zod.object({
  workflows: zod
    .array(
      zod.object({
        id: zod.string(),
        name: zod.string(),
        description: zod.string(),
        fields: zod.array(zod.string()),
        fields_more: zod.number().optional(),
      }),
    )
    .optional(),
  workflows_more: zod.number().optional(),
});

/** @returns what the agent summary says of the slice, parsed. */
function summarize(slice: WorkflowSlice | undefined): zod.infer<typeof summaryShape> {
  const summary = workflowReducer.agentSummary?.(
    slice,
    { url: () => "" },
    {
      project: {
        id: brandString<ProjectId>("p1"),
        title: "Test",
        created_at: at(0),
        path: "/tmp/p1",
      },
      head: rid("h"),
      components: {
        proj: { records: [], stale: {}, superseded: {}, created_by: {}, proposals: {} },
      },
    },
    brandString<SessionId>("s"),
  );
  return summaryShape.parse(summary ?? {});
}

describe("workflowReducer", () => {
  it("starts empty", () => {
    expect(workflowReducer.initial()).toEqual({ items: {} });
  });

  it("makes a workflow of a done create record", () => {
    const slice = fold(create("w1", 5, "Portrait", { target: TARGET }));
    expect(itemOf(slice, "w1")).toEqual({
      id: "w1",
      name: "Portrait",
      description: "About Portrait",
      graph: brandString<AssetId>("graph-Portrait"),
      fields: [STEPS, TEXT],
      parent: null,
      target: TARGET,
      nodes: 7,
      created_at: at(5),
      updated_at: at(5),
    });
  });

  it("has no target when create gave none or null", () => {
    expect(itemOf(fold(create("w1", 1)), "w1").target).toBeNull();
    expect(itemOf(fold(create("w1", 1, "w1", { target: null })), "w1").target).toBeNull();
  });

  it("trims the fields it stores", () => {
    const long = Array.from({ length: WORKFLOW_LIMITS.fieldOptions + 1 }, String);
    const slice = fold(
      record({
        id: "w1",
        operation: WORKFLOW_OPERATIONS.create,
        time: 1,
        report: made("w", { fields: [{ ...TEXT, options: long }] }),
      }),
    );
    expect(itemOf(slice, "w1").fields[0]).not.toHaveProperty("options");
  });

  it("makes a variant that points at its parent and inherits its target", () => {
    const slice = fold(
      create("w1", 1, "Base", { target: TARGET }),
      record({
        id: "v1",
        operation: WORKFLOW_OPERATIONS.saveVariant,
        time: 2,
        params: { workflow: "w1", ops: [], name: "Variant" },
        report: made("Variant"),
      }),
    );
    expect(itemOf(slice, "v1")).toMatchObject({ parent: "w1", target: TARGET, name: "Variant" });
    expect(itemOf(slice, "w1").updated_at).toBe(at(1));
  });

  it("makes a variant without a parent when the parent is not there", () => {
    const slice = fold(
      record({
        id: "v1",
        operation: WORKFLOW_OPERATIONS.saveVariant,
        time: 2,
        params: { workflow: "gone" },
        report: made("Variant"),
      }),
    );
    expect(itemOf(slice, "v1")).toMatchObject({ parent: null, target: null });
  });

  it("makes a copy without a parent or a target", () => {
    const slice = fold(
      create("w1", 1, "Base", { target: TARGET }),
      record({
        id: "c1",
        operation: WORKFLOW_OPERATIONS.copy,
        time: 2,
        params: { project: "p2", workflow: "w1" },
        report: made("Copy"),
      }),
    );
    expect(itemOf(slice, "c1")).toMatchObject({ parent: null, target: null, name: "Copy" });
  });

  describe("update", () => {
    it("changes the name and description, trimmed, and the time", () => {
      const slice = fold(base(), update({ name: "  New ", description: " d " }));
      expect(itemOf(slice, "w1")).toMatchObject({
        name: "New",
        description: "d",
        updated_at: at(9),
        created_at: at(1),
      });
    });

    it("leaves what the params do not name", () => {
      const slice = fold(base(), update({ description: "only" }));
      expect(itemOf(slice, "w1")).toMatchObject({
        name: "Base",
        fields: [STEPS, TEXT],
        target: TARGET,
      });
    });

    it("takes the checked fields from the report", () => {
      const slice = fold(base(), update({ fields: [] }, { fields: [TEXT] }));
      expect(itemOf(slice, "w1").fields).toEqual([TEXT]);
      expect(itemOf(fold(base(), update({ name: "x" }, {})), "w1").fields).toEqual([STEPS, TEXT]);
    });

    it("clears the target with null, sets it with an object, leaves it when absent", () => {
      expect(itemOf(fold(base(), update({ target: null })), "w1").target).toBeNull();
      const other = { provider: "p2", target: "t2" };
      expect(itemOf(fold(base(), update({ target: other })), "w1").target).toEqual(other);
      expect(itemOf(fold(base(), update({ name: "x" })), "w1").target).toEqual(TARGET);
    });

    it("skips an update of a workflow that is not there", () => {
      const slice = fold(base(), update({ workflow: "nope", name: "x" }));
      expect(slice).toEqual(fold(base()));
    });
  });

  describe("delete", () => {
    it("removes the workflow and clears the parent of its variants", () => {
      const slice = fold(
        create("w1", 1),
        variant("v1", "w1", 2),
        variant("v2", "w1", 3),
        remove("w1", 4),
      );
      expect(Object.keys(slice.items).toSorted()).toEqual(["v1", "v2"]);
      expect(itemOf(slice, "v1").parent).toBeNull();
      expect(itemOf(slice, "v2").parent).toBeNull();
    });

    it("keeps the parent of a variant when another workflow is deleted", () => {
      const slice = fold(create("w1", 1), create("w2", 2), variant("v1", "w1", 3), remove("w2", 4));
      expect(itemOf(slice, "v1").parent).toBe("w1");
    });

    it("ignores the delete of an unknown workflow", () => {
      const before = fold(create("w1", 1));
      expect(fold(create("w1", 1), remove("zz", 2))).toEqual(before);
    });
  });

  describe("records it does not use", () => {
    it("skips records of the other statuses", () => {
      for (const status of ["pending", "running", "failed", "cancelled"] as const) {
        const next = record({
          id: "w1",
          operation: WORKFLOW_OPERATIONS.create,
          time: 1,
          report: made("w"),
          status,
        });
        expect(fold(next).items).toEqual({});
      }
    });

    it("ignores operations of other components and the read operations", () => {
      const slice = fold(
        record({ id: "a", operation: "asset.import", time: 1, report: made("x") }),
        record({ id: "b", operation: WORKFLOW_OPERATIONS.list, time: 2, report: made("x") }),
        record({
          id: "c",
          operation: WORKFLOW_OPERATIONS.graph,
          time: 3,
          params: { workflow: "w" },
        }),
      );
      expect(slice).toEqual({ items: {} });
    });

    it("skips records whose params or report do not parse, without throwing", () => {
      const slice = fold(
        record({ id: "r1", operation: WORKFLOW_OPERATIONS.create, time: 1 }),
        record({ id: "r2", operation: WORKFLOW_OPERATIONS.create, time: 2, report: { graph: 5 } }),
        record({
          id: "r3",
          operation: WORKFLOW_OPERATIONS.create,
          time: 3,
          params: { target: "text" },
          report: made("x"),
        }),
        record({
          id: "r4",
          operation: WORKFLOW_OPERATIONS.create,
          time: 4,
          report: made("x", { fields: [{ id: "x" }] }),
        }),
        record({
          id: "r5",
          operation: WORKFLOW_OPERATIONS.saveVariant,
          time: 5,
          report: made("x"),
        }),
        record({ id: "r6", operation: WORKFLOW_OPERATIONS.copy, time: 6, report: made("x") }),
        record({ id: "r7", operation: WORKFLOW_OPERATIONS.update, time: 7, params: { name: 3 } }),
        record({ id: "r8", operation: WORKFLOW_OPERATIONS.delete, time: 8, params: {} }),
      );
      expect(slice).toEqual({ items: {} });
    });

    it("skips an update whose report does not parse", () => {
      const slice = fold(
        create("w1", 1),
        record({
          id: "u",
          operation: WORKFLOW_OPERATIONS.update,
          time: 2,
          params: { workflow: "w1", name: "x" },
          report: { fields: "no" },
        }),
      );
      expect(itemOf(slice, "w1").name).toBe("w1");
    });

    it("tolerates an undefined slice", () => {
      expect(workflowReducer.reduce(undefined, create("w1", 1))?.items).toHaveProperty("w1");
    });
  });

  describe("agentSummary", () => {
    it("has no field without workflows", () => {
      expect(summarize({ items: {} })).toEqual({});
      expect(summarize(undefined)).toEqual({});
    });

    it("lists newest updated first, then by ID, with the field IDs", () => {
      const slice = fold(create("b", 1), create("a", 1), create("c", 2));
      const summary = summarize(slice);
      expect(summary.workflows).toEqual([
        { id: "c", name: "c", description: "About c", fields: ["3.steps", "6.text"] },
        { id: "a", name: "a", description: "About a", fields: ["3.steps", "6.text"] },
        { id: "b", name: "b", description: "About b", fields: ["3.steps", "6.text"] },
      ]);
      expect(summary).not.toHaveProperty("workflows_more");
    });

    it("cuts a long description with an ellipsis", () => {
      const slice = fold(
        record({
          id: "w1",
          operation: WORKFLOW_OPERATIONS.create,
          time: 1,
          report: made("w", { description: "d".repeat(400) }),
        }),
      );
      const first = summarize(slice).workflows?.[0];
      expect(first?.description).toHaveLength(WORKFLOW_LIMITS.summaryDescriptionChars);
      expect(first?.description.endsWith("…")).toBe(true);
    });

    it("lists at most the limit and counts the rest", () => {
      const records = Array.from({ length: WORKFLOW_LIMITS.summaryItems + 5 }, (_, i) =>
        create(`w${String(i).padStart(3, "0")}`, i),
      );
      const summary = summarize(fold(...records));
      const listed = summary.workflows ?? [];
      expect(listed).toHaveLength(WORKFLOW_LIMITS.summaryItems);
      expect(listed[0]?.id).toBe(`w${String(WORKFLOW_LIMITS.summaryItems + 4).padStart(3, "0")}`);
      expect(summary.workflows_more).toBe(5);
    });
  });

  it("has no mentions: the graph blobs are not library assets", () => {
    expect("mentions" in workflowReducer).toBe(false);
  });
});

describe("agentSummary of a workflow with many fields", () => {
  it("lists at most 30 field IDs and counts the rest", () => {
    const fields: WorkflowParam[] = Array.from({ length: 45 }, (_, i) => ({
      ...STEPS,
      id: `${i}.steps`,
      nodeId: String(i),
    }));
    const slice: WorkflowSlice = {
      items: {
        [rid("a")]: {
          id: rid("a"),
          name: "Many",
          description: "",
          graph: brandString<AssetId>("g"),
          fields,
          parent: null,
          target: null,
          nodes: 1,
          created_at: at(0),
          updated_at: at(0),
        },
        [rid("b")]: {
          id: rid("b"),
          name: "Few",
          description: "",
          graph: brandString<AssetId>("g"),
          fields: fields.slice(0, 30),
          parent: null,
          target: null,
          nodes: 1,
          created_at: at(0),
          updated_at: at(0),
        },
      },
    };
    const workflows = summarize(slice).workflows ?? [];
    const many = workflows.find((entry) => entry.id === "a");
    expect(many?.fields).toHaveLength(30);
    expect(many?.fields_more).toBe(15);
    const few = workflows.find((entry) => entry.id === "b");
    expect(few?.fields).toHaveLength(30);
    expect(few).not.toHaveProperty("fields_more");
  });
});
