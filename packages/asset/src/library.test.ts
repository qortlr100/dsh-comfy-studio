/** Tests of the library listing: filters, search, ordering, cursor paging, limits, and assets the store lacks. */
import { describe, expect, it } from "vitest";
import { ProjectError } from "@cs/project";
import { listAssets, type AssetListQuery } from "./library.ts";
import {
  assetId,
  at,
  fakeStore,
  fold,
  makeRecord,
  stateOf,
  storedAsset,
  type RecordSpec,
} from "./testing/library.ts";

/** @returns the IDs of a page, in order. */
function ids(report: { items: Array<{ id: string }> }): string[] {
  return report.items.map((entry) => entry.id);
}

/** The library of most tests: a nested folder, assets of every kind and review, and searchable producers. */
function library() {
  const specs: RecordSpec[] = [
    { id: "f1", operation: "asset.folder_create", time: 1, params: { name: "characters" } },
    { id: "f2", operation: "asset.folder_create", time: 2, params: { name: "hero", parent: "f1" } },
    {
      id: "g1",
      operation: "gen.make",
      time: 10,
      outputs: [assetId("p1")],
      intent: "a Red dragon over the sea",
      params: { prompt: "dragon, sunset", seed: 7 },
    },
    {
      id: "g2",
      operation: "gen.make",
      time: 11,
      outputs: [assetId("p2")],
      intent: "castle",
      params: {},
    },
    { id: "i1", operation: "asset.import", time: 12, outputs: [assetId("a1"), assetId("a2")] },
    { id: "i2", operation: "asset.import", time: 13, outputs: [assetId("v1"), assetId("n1")] },
    {
      id: "r1",
      operation: "asset.review",
      time: 14,
      assets: [assetId("p1")],
      params: { review: "adopted" },
    },
    {
      id: "r2",
      operation: "asset.review",
      time: 15,
      assets: [assetId("p2")],
      params: { review: "held" },
    },
    {
      id: "m1",
      operation: "asset.move",
      time: 16,
      assets: [assetId("a1")],
      params: { folder: "f1" },
    },
    {
      id: "m2",
      operation: "asset.move",
      time: 17,
      assets: [assetId("a2")],
      params: { folder: "f2" },
    },
    {
      id: "t1",
      operation: "asset.tag",
      time: 18,
      assets: [assetId("a1")],
      params: { add: ["hero", "blue"] },
    },
    {
      id: "t2",
      operation: "asset.tag",
      time: 19,
      assets: [assetId("a2")],
      params: { add: ["Hero"] },
    },
    {
      id: "g3",
      operation: "gen.make",
      time: 20,
      outputs: [assetId("p3")],
      intent: "pending one",
      params: {},
    },
  ];
  const records = specs.map(makeRecord);
  const slice = fold(records);
  const store = fakeStore([
    storedAsset(assetId("p1"), "dragon.png"),
    storedAsset(assetId("p2"), "castle.png"),
    storedAsset(assetId("p3"), "pending.png"),
    storedAsset(assetId("a1"), "Knight.PNG"),
    storedAsset(assetId("a2"), "mage.png"),
    storedAsset(assetId("v1"), "clip.mp4", "video/mp4"),
    storedAsset(assetId("n1"), "notes.pdf", "application/pdf"),
  ]);
  const state = stateOf(
    slice,
    records.filter((record) => record.operation !== "asset.import"),
  );
  return { state, store, slice, query: (query: AssetListQuery) => listAssets(state, store, query) };
}

/** 35 adopted images with the times 1..35; two share a time to exercise the tie on the ID. */
function many() {
  const records = Array.from({ length: 35 }, (_, index) =>
    makeRecord({
      id: `i${String(index)}`,
      operation: "asset.import",
      time: index < 2 ? 1 : index,
      outputs: [assetId(`x${String(index).padStart(2, "0")}`)],
    }),
  );
  const store = fakeStore(
    records.flatMap((record) => record.outputs.map((id) => storedAsset(id, `${id}.png`))),
  );
  const state = stateOf(fold(records));
  return { state, store };
}

describe("listAssets", () => {
  it("lists adopted assets by default, newest first, with the fields of an entry", () => {
    const { query } = library();
    const report = query({});
    // p1 was added at 10 (an output adopted later); the imports at 12 and 13 (id descending within a time).
    expect(ids(report)).toEqual(["v1", "n1", "a2", "a1", "p1"]);
    expect(report.next_cursor).toBeNull();
    const knight = report.items.find((entry) => entry.id === "a1");
    expect(knight).toEqual({
      id: "a1",
      name: "Knight.PNG",
      kind: "image",
      mime: "image/png",
      folder: "characters",
      review: "adopted",
      tags: ["blue", "hero"],
      origin: "import",
      record: "i1",
      made_by: null,
      added_at: at(12),
      url: "/api/cs/asset?id=a1",
    });
    expect(report.items.find((entry) => entry.id === "a2")?.folder).toBe("characters/hero");
  });

  it("names the tool of the operation that made an output", () => {
    const { query } = library();
    expect(query({}).items.find((entry) => entry.id === "p1")).toMatchObject({
      origin: "output",
      made_by: "cs_gen_make",
      record: "g1",
    });
  });

  it("selects the review state", () => {
    const { query } = library();
    expect(ids(query({ review: "pending" }))).toEqual(["p3"]);
    expect(ids(query({ review: "held" }))).toEqual(["p2"]);
  });

  it("filters by folder exactly: a folder ID, or root, and not the subfolders", () => {
    const { query } = library();
    expect(ids(query({ folder: "f1" }))).toEqual(["a1"]);
    expect(ids(query({ folder: "f2" }))).toEqual(["a2"]);
    expect(ids(query({ folder: "root" }))).toEqual(["v1", "n1", "p1"]);
    expect(ids(query({ folder: "nope" }))).toEqual([]);
  });

  it("filters by kind", () => {
    const { query } = library();
    expect(ids(query({ kind: "video" }))).toEqual(["v1"]);
    expect(ids(query({ kind: "file" }))).toEqual(["n1"]);
    expect(ids(query({ kind: "audio" }))).toEqual([]);
  });

  it("filters by all tags, ignoring case", () => {
    const { query } = library();
    expect(ids(query({ tags: ["hero"] }))).toEqual(["a2", "a1"]);
    expect(ids(query({ tags: ["HERO", "blue"] }))).toEqual(["a1"]);
    expect(ids(query({ tags: ["hero", "green"] }))).toEqual([]);
  });

  it("searches names, tags, and the intent and params of the producing record", () => {
    const { query } = library();
    expect(ids(query({ q: "knight" }))).toEqual(["a1"]);
    expect(ids(query({ q: "BLUE" }))).toEqual(["a1"]);
    // The intent of g1, in another case.
    expect(ids(query({ q: "red dragon" }))).toEqual(["p1"]);
    // The JSON text of its params; the words may match different sources.
    expect(ids(query({ q: "sunset dragon.png" }))).toEqual(["p1"]);
    expect(ids(query({ q: "seed" }))).toEqual(["p1"]);
    expect(ids(query({ q: "dragon knight" }))).toEqual([]);
    expect(ids(query({ q: "   " }))).toEqual(ids(query({})));
  });

  it("uses at most 8 words of a search and 5 tags of a filter", () => {
    const { query } = library();
    expect(
      ids(query({ q: "dragon dragon dragon dragon dragon dragon dragon dragon nonsense" })),
    ).toEqual(["p1"]);
    expect(ids(query({ tags: ["hero", "hero", "hero", "hero", "hero", "green"] }))).toEqual([
      "a2",
      "a1",
    ]);
  });

  it("skips an asset whose store entry is missing", () => {
    const { state, store } = library();
    store.entries.delete(assetId("a2"));
    expect(ids(listAssets(state, store, { tags: ["hero"] }))).toEqual(["a1"]);
  });

  it("answers an empty page for a project without the asset slice", () => {
    const store = fakeStore();
    expect(listAssets(stateOf(undefined), store, {})).toEqual({ items: [], next_cursor: null });
  });

  describe("paging", () => {
    it("pages with a cursor to the end without a gap or a repeat", () => {
      const { state, store } = many();
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const report = listAssets(
          state,
          store,
          cursor === undefined ? { limit: 10 } : { limit: 10, cursor },
        );
        seen.push(...ids(report));
        cursor = report.next_cursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined);
      expect(pages).toBe(4);
      expect(seen).toHaveLength(35);
      expect(new Set(seen).size).toBe(35);
      // Newest first; x01 and x00 share the oldest time, and the larger ID comes first.
      expect(seen.slice(0, 2)).toEqual(["x34", "x33"]);
      expect(seen.slice(-2)).toEqual(["x01", "x00"]);
    });

    it("clamps the limit to 1..100 and defaults to 30", () => {
      const { state, store } = many();
      expect(listAssets(state, store, {}).items).toHaveLength(30);
      expect(listAssets(state, store, { limit: 0 }).items).toHaveLength(1);
      expect(listAssets(state, store, { limit: -4 }).items).toHaveLength(1);
      expect(listAssets(state, store, { limit: 1000 }).items).toHaveLength(35);
      expect(listAssets(state, store, { limit: 2.9 }).items).toHaveLength(2);
      expect(listAssets(state, store, { limit: Number.NaN }).items).toHaveLength(30);
      expect(listAssets(state, store, { limit: 35 }).next_cursor).toBeNull();
    });

    it("refuses a cursor that is not one of ours", () => {
      const { state, store } = many();
      for (const cursor of [
        "!!!",
        "bm90IGpzb24",
        Buffer.from('["only one"]').toString("base64url"),
      ]) {
        expect(() => listAssets(state, store, { cursor })).toThrow(ProjectError);
        expect(() => listAssets(state, store, { cursor })).toThrow(
          expect.objectContaining({ code: "invalid_params" }),
        );
      }
    });
  });
});
