import { describe, expect, it } from "vitest";
import type { AssetId, OperationSpec, ProjectLine, ProjectState } from "@cs/project";
import { standIn } from "@cs/project/testing/support";
import {
  mentionedAssets,
  projectIdOf,
  toWireOperation,
  toWireState,
  type WireAsset,
} from "./wire.ts";

/** A state with two records: `r1` makes `a1`, `r2` reads `a1` and `a2` (and an unresolved input). */
function sampleState(): ProjectState {
  return standIn({
    project: { id: "p", title: "P", created_at: "2026-01-01T00:00:00.000Z", path: "/p" },
    components: {
      proj: {
        records: [
          { id: "r1", operation: "x.make", outputs: ["a1"], inputs: [] },
          {
            id: "r2",
            operation: "x.use",
            outputs: [],
            inputs: [
              { role: "s", resolved_asset: "a1" },
              { role: "s", resolved_asset: null },
              { role: "s", resolved_asset: "a2" },
            ],
          },
        ],
        created_by: { a1: "r1", a3: "r-discarded" },
      },
    },
  });
}

/**
 * @param held - the asset IDs the fake store holds.
 * @returns an asset lookup.
 */
function storeOf(held: string[]): (id: AssetId) => WireAsset | null {
  return (id) =>
    held.includes(id) ? { id, mime: "image/png", name: `${id}.png`, url: `/assets/${id}` } : null;
}

describe("mentionedAssets", () => {
  it("lists created assets first, then record outputs and resolved inputs, each once", () => {
    expect(mentionedAssets(sampleState())).toEqual(["a1", "a3", "a2"]);
  });

  it("is empty for a state with no records", () => {
    const state = standIn<ProjectState>({
      components: { proj: { records: [], created_by: {} } },
    });
    expect(mentionedAssets(state)).toEqual([]);
  });
});

describe("toWireState", () => {
  const line = standIn<ProjectLine>({ tip: "r2", at: "r1" });

  it("names the operation that made each asset and leaves unknown assets out", () => {
    const wire = toWireState(sampleState(), line, storeOf(["a1", "a3"]));
    expect(wire.assets.map((asset) => [asset.id, asset.made_by])).toEqual([
      ["a1", "x.make"],
      ["a3", null],
    ]);
    expect(wire.assets[0]).toEqual({
      id: "a1",
      mime: "image/png",
      name: "a1.png",
      url: "/assets/a1",
      made_by: "x.make",
    });
  });

  it("gives an asset the project only references made_by null", () => {
    const wire = toWireState(sampleState(), line, storeOf(["a2"]));
    expect(wire.assets).toEqual([expect.objectContaining({ id: "a2", made_by: null })]);
  });

  it("reports head as the current position and tip as the last step", () => {
    const state = sampleState();
    const wire = toWireState(state, line, storeOf([]));
    expect(wire.head).toBe("r1");
    expect(wire.tip).toBe("r2");
    expect(wire.project).toBe(state.project);
    expect(wire.components).toBe(state.components);
    expect(wire.assets).toEqual([]);
  });
});

/** @returns an operation spec with executable parts. */
function spec(overrides: Partial<OperationSpec> = {}): OperationSpec {
  return {
    name: "x.make",
    component: "x",
    version: "2",
    description: "Make.",
    params: { a: { type: "string", description: "A." } },
    inputs: {},
    outputs: [],
    deterministic: true,
    resource: "gpu",
    summarize: () => "made",
    execute: () => Promise.resolve({ outputs: [] }),
    ...overrides,
  };
}

describe("toWireOperation", () => {
  it("keeps only the declaration, with no executable parts", () => {
    const wire = toWireOperation(spec());
    expect(Object.keys(wire).toSorted()).toEqual([
      "description",
      "deterministic",
      "inputs",
      "name",
      "outputs",
      "params",
      "resource",
      "version",
    ]);
    expect(wire).toMatchObject({
      name: "x.make",
      version: "2",
      deterministic: true,
      resource: "gpu",
    });
  });

  it("adds the label only when the operation declares one", () => {
    expect(toWireOperation(spec())).not.toHaveProperty("label");
    expect(toWireOperation(spec({ label: "Make it" }))).toHaveProperty("label", "Make it");
  });
});

describe("projectIdOf", () => {
  it("accepts 1 to 128 characters of letters, digits, underscore and hyphen", () => {
    expect(projectIdOf("abc-1_Z")).toBe("abc-1_Z");
    expect(projectIdOf("a")).toBe("a");
    expect(projectIdOf("x".repeat(128))).toBe("x".repeat(128));
  });

  it("rejects everything else with null", () => {
    for (const value of [
      "",
      "x".repeat(129),
      "a b",
      "a/b",
      "a.b",
      "../x",
      "é",
      null,
      undefined,
      5,
      {},
      ["a"],
    ]) {
      expect(projectIdOf(value)).toBeNull();
    }
  });
});
