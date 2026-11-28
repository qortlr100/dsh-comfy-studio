/**
 * Tests of the reducer registry and Project's own `proj` slice: slices computed from the records of the effective chain,
 * one reducer per key, one owner per reference kind, stale and superseded marks, stale acceptance, version references
 * resolved, and their producers found, through their reference kind, and the kinds and newest version of an ID. Records
 * are appended after the head directly through the record store.
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it } from "vitest";
import type { ProjectModules } from "./testing/support.ts";
import {
  asError,
  createTestProject,
  startModules,
  testKind,
  userOrigin,
  versionKey,
} from "./testing/support.ts";
import { ProjectError } from "./shared.ts";
import type { RecordLineInput } from "./record-store.ts";
import type {
  AssetId,
  ComponentStates as States,
  ProjectId,
  ProjectRecord,
  RecordInput,
} from "./types.ts";

declare module "@cs/project/types" {
  interface ComponentStates {
    /** The slice of the counting test reducer: how many `batch` records the chain holds. */
    reducers_test?: { count: number };
  }
}

/** The `test_character` ID that the `test_library` reducers record. */
const HERO = "hero";

/** A record's operation, plus the record-line fields that differ from a plain finished human edit. */
type RecordLineFields = Pick<RecordLineInput, "component" | "operation"> & Partial<RecordLineInput>;

/**
 * Append one record after the project's head, under the lock.
 * @param m - the modules.
 * @param project - the project.
 * @param fields - the record's operation and the fields that differ from a plain finished human edit.
 * @returns the record.
 */
function append(
  m: ProjectModules,
  project: ProjectId,
  fields: RecordLineFields,
): Promise<ProjectRecord> {
  return m.store.lock(project, () =>
    m.store.append(project, {
      parents: [m.store.line(project)!.at],
      kind: "operation",
      operation_version: "1",
      ...userOrigin({ session: null }),
      params: {},
      inputs: [],
      outputs: [],
      based_on: null,
      supersedes: [],
      deterministic: false,
      status: "done",
      ...fields,
    }),
  );
}

/**
 * @param asset - an asset.
 * @returns a `reference` input that reads the asset.
 */
function uses(asset: AssetId): RecordInput {
  return { role: "reference", ref: { asset }, resolved_asset: asset };
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @returns the `proj` slice of the current state.
 */
function projSlice(m: ProjectModules, project: ProjectId): States["proj"] {
  return m.reducers.getState(project).components.proj;
}

/** An image generation: component `image`, operation `image.generate`. */
const GENERATE = { component: "image", operation: "image.generate" } as const;
/** A batch edit: component `batch`, operation `batch.item_insert`. */
const INSERT = { component: "batch", operation: "batch.item_insert" } as const;

describe("reducers", () => {
  it("computes each registered slice from the records of the effective chain", async () => {
    const m = startModules();
    m.reducers.register("reducers_test", {
      initial: () => ({ count: 0 }),
      reduce: (slice, record) =>
        record.component === "batch" ? { count: (slice?.count ?? 0) + 1 } : slice,
    });
    const project = await createTestProject(m);
    await append(m, project, INSERT);
    await append(m, project, GENERATE);
    const last = await append(m, project, INSERT);
    const state = m.reducers.getState(project);
    expect(state).toMatchObject({ head: last.id, project: m.store.getProject(project) });
    expect(state.components.reducers_test?.count).toBe(2);
    expect(state.components.proj.records).toEqual(m.store.ancestors(project, last.id));
    expect(() => m.reducers.getState(brandString<ProjectId>("missing"))).toThrow(ProjectError);
  });

  it("refuses a second reducer for a key", () => {
    const m = startModules();
    const reducer = { initial: () => ({ count: 0 }), reduce: (slice: { count: number }) => slice };
    const remove = m.reducers.register("reducers_test", reducer);
    let error: unknown = null;
    try {
      m.reducers.register("reducers_test", reducer);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ProjectError);
    expect(asError(error, ProjectError).code).toBe("reducer_exists");
    remove();
    expect(() => m.reducers.register("reducers_test", reducer)).not.toThrow();
  });

  it("registers one owner per reference kind and lists the kinds in registration order", () => {
    const m = startModules();
    const remove = m.reducers.registerKind(testKind("test_character"));
    m.reducers.registerKind(testKind("test_location"));
    expect(m.reducers.listReferenceKinds()).toEqual(["test_character", "test_location"]);
    expect(() => m.reducers.registerKind(testKind("test_character"))).toThrow(
      expect.objectContaining({ code: "kind_exists" }),
    );
    remove();
    expect(m.reducers.listReferenceKinds()).toEqual(["test_location"]);
    m.reducers.registerKind(testKind("test_character"));
    // A remover removes only its own registration.
    remove();
    expect(m.reducers.listReferenceKinds()).toEqual(["test_location", "test_character"]);
  });

  it("marks consumers of a superseded record stale", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const x = m.assets.add("variant x");
    const y = m.assets.add("export y");
    const a = await append(m, project, { ...GENERATE, outputs: [x] });
    const b = await append(m, project, { ...INSERT, inputs: [uses(x)], outputs: [y] });
    const d = await append(m, project, { ...INSERT, inputs: [uses(y)] });
    const c = await append(m, project, {
      ...GENERATE,
      outputs: [m.assets.add("variant x2")],
      based_on: a.id,
      supersedes: [a.id],
    });
    const later = await append(m, project, { ...INSERT, inputs: [uses(x)] });
    const slice = projSlice(m, project);
    expect(slice.superseded).toEqual({ [a.id]: c.id });
    expect(slice.created_by[x]).toBe(a.id);
    expect(slice.stale).toEqual({ [b.id]: c.id, [d.id]: c.id, [later.id]: c.id });
  });

  it("marks the consumer of a record's output stale when that record is superseded, though a later record output the same asset", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const x = m.assets.add("variant x");
    const a = await append(m, project, { ...GENERATE, outputs: [x] });
    // B names output 0 of A; C repeats A and gives the same asset, as a reused deterministic call does.
    const b = await append(m, project, {
      ...INSERT,
      inputs: [{ role: "reference", ref: { record: a.id, output: 0 }, resolved_asset: x }],
    });
    const c = await append(m, project, { ...GENERATE, outputs: [x] });
    const byAsset = await append(m, project, { ...INSERT, inputs: [uses(x)] });
    const d = await append(m, project, {
      ...GENERATE,
      outputs: [m.assets.add("variant x2")],
      supersedes: [a.id],
    });
    const slice = projSlice(m, project);
    expect(slice.created_by[x]).toBe(c.id);
    // The input that names A is stale; the input that names the asset reads it from C, which stands.
    expect(slice.stale).toEqual({ [b.id]: d.id });
    expect(slice.stale[byAsset.id]).toBeUndefined();
  });

  it("keeps a record fresh after proj.stale_accept", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const x = m.assets.add("variant x");
    const y = m.assets.add("export y");
    const a = await append(m, project, { ...GENERATE, outputs: [x] });
    const b = await append(m, project, { ...INSERT, inputs: [uses(x)], outputs: [y] });
    const d = await append(m, project, { ...INSERT, inputs: [uses(y)] });
    await append(m, project, {
      ...GENERATE,
      outputs: [m.assets.add("variant x2")],
      supersedes: [a.id],
    });
    expect(Object.keys(projSlice(m, project).stale)).toEqual([b.id, d.id]);
    await append(m, project, {
      component: "proj",
      operation: "proj.stale_accept",
      params: { record: b.id },
      deterministic: true,
    });
    expect(projSlice(m, project).stale).toEqual({});
    await append(m, project, INSERT);
    expect(projSlice(m, project).stale).toEqual({});
    // A later consumer of the accepted record's output is not stale through it.
    await append(m, project, { ...INSERT, inputs: [uses(y)] });
    expect(projSlice(m, project).stale).toEqual({});
  });

  it("resolves version references through their reference kind, on the slice of its owner", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const ref = { test_character: HERO, version: 1 };
    m.reducers.registerKind(testKind("test_character"));
    // A kind whose owner has no reducer knows no version.
    expect(m.reducers.assetsOf(m.reducers.getState(project), ref)).toBeNull();
    expect(m.reducers.kindsWithVersion(m.reducers.getState(project), HERO, 1)).toEqual([]);
    const face = m.assets.add("hero face");
    m.reducers.register("test_library", {
      initial: () => ({ assets: {}, creators: {} }),
      reduce: (slice, record) =>
        record.operation === "library.character_create"
          ? {
              assets: { [versionKey("test_character", HERO, 1)]: record.outputs },
              creators: { [versionKey("test_character", HERO, 1)]: record.id },
            }
          : slice,
    });
    await append(m, project, {
      component: "library",
      operation: "library.character_create",
      params: { character: "hero" },
      outputs: [face],
    });
    const withLibrary = m.reducers.getState(project);
    expect(m.reducers.assetsOf(withLibrary, ref)).toEqual([face]);
    expect(m.reducers.kindsWithVersion(withLibrary, HERO, 1)).toEqual(["test_character"]);
    expect(m.reducers.assetsOf(withLibrary, { test_character: HERO, version: 2 })).toBeNull();
    // A kind that is not registered, and an asset, stand for no version.
    expect(m.reducers.assetsOf(withLibrary, { test_location: HERO, version: 1 })).toBeNull();
    expect(m.reducers.assetsOf(withLibrary, { asset: face })).toBeNull();
  });

  it("lists the kinds that have an ID and the newest version of an ID, on the slice of each owner", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    m.reducers.registerKind(testKind("test_character"));
    m.reducers.registerKind(testKind("test_location"));
    // A kind whose owner has no reducer knows no ID.
    expect(m.reducers.kindsWithId(m.reducers.getState(project), HERO)).toEqual([]);
    m.reducers.register("test_library", {
      initial: () => ({ assets: {}, creators: {} }),
      reduce(slice, record) {
        if (record.operation !== "library.write") return slice;
        const kind = String(record.params["kind"]);
        const key = versionKey(
          kind,
          HERO,
          Object.keys(slice?.creators ?? {}).filter((entry) => entry.startsWith(`${kind}:`))
            .length + 1,
        );
        return { assets: slice?.assets ?? {}, creators: { ...slice?.creators, [key]: record.id } };
      },
    });
    const write = (kind: string) =>
      append(m, project, { component: "library", operation: "library.write", params: { kind } });
    await write("test_location");
    await write("test_location");
    const located = m.reducers.getState(project);
    expect(m.reducers.kindsWithId(located, HERO)).toEqual(["test_location"]);
    expect(m.reducers.latestVersion(located, "test_location", HERO)).toBe(2);
    expect(m.reducers.latestVersion(located, "test_character", HERO)).toBeNull();
    await write("test_character");
    // The kinds come in registration order, whichever wrote the ID first.
    expect(m.reducers.kindsWithId(m.reducers.getState(project), HERO)).toEqual([
      "test_character",
      "test_location",
    ]);
    // An unknown ID, and a kind that is not registered, have no version.
    expect(m.reducers.kindsWithId(located, "villain")).toEqual([]);
    expect(m.reducers.latestVersion(located, "test_style", HERO)).toBeNull();
  });

  it("marks records that read a superseded character version stale", async () => {
    const m = startModules();
    const project = await createTestProject(m);
    const face = m.assets.add("hero face");
    m.reducers.register("test_library", {
      initial: () => ({ assets: {}, creators: {} }),
      reduce(slice, record) {
        if (
          record.operation !== "library.character_create" &&
          record.operation !== "library.character_update"
        )
          return slice;
        const key = versionKey(
          "test_character",
          HERO,
          Object.keys(slice?.creators ?? {}).length + 1,
        );
        return {
          assets: { ...slice?.assets, [key]: [face] },
          creators: { ...slice?.creators, [key]: record.id },
        };
      },
    });
    m.reducers.registerKind(testKind("test_character"));
    /** A generation that reads one version of the hero. */
    const reads = (version: number): RecordInput => ({
      role: "reference",
      ref: { test_character: HERO, version },
      resolved_asset: face,
    });
    const create = await append(m, project, {
      component: "library",
      operation: "library.character_create",
    });
    const x = m.assets.add("variant x");
    const gen = await append(m, project, { ...GENERATE, inputs: [reads(1)], outputs: [x] });
    const insert = await append(m, project, { ...INSERT, inputs: [uses(x)] });
    const update = await append(m, project, {
      component: "library",
      operation: "library.character_update",
      supersedes: [create.id],
    });
    const late = await append(m, project, { ...GENERATE, inputs: [reads(1)] });
    await append(m, project, { ...GENERATE, inputs: [reads(2)] });
    expect(projSlice(m, project).stale).toEqual({
      [gen.id]: update.id,
      [insert.id]: update.id,
      [late.id]: update.id,
    });
    // Accepting the generation also clears the stale mark of the item made from it.
    await append(m, project, {
      component: "proj",
      operation: "proj.stale_accept",
      params: { record: gen.id },
      deterministic: true,
    });
    expect(projSlice(m, project).stale).toEqual({ [late.id]: update.id });
  });
});
