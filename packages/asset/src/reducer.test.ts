/**
 * Tests of the asset reducer: each rule of the plan, the default review by origin, and the order independence of
 * imports (which the registry reduces after every step) against steps that happened later in real time.
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import { describe, expect, it } from "vitest";
import type { SessionId } from "@cs/project/types";
import { assetReducer } from "./reducer.ts";
import {
  assetId,
  at,
  fold,
  importEvent,
  makeRecord,
  recordId,
  reduceRealTimeOrder,
  reduceRegistryOrder,
  stateOf,
  stepEvent,
  type Event,
  type RecordSpec,
} from "./testing/library.ts";
import type { AssetItem } from "./types.ts";

const SESSION = brandString<SessionId>("s");
const A = assetId("a");
const B = assetId("b");

/** @returns a step on assets of the `asset` role. */
function step(
  id: string,
  operation: string,
  time: number,
  assets: ReturnType<typeof assetId>[],
  params: Record<string, unknown> = {},
): Event {
  return stepEvent({ id, operation, time, assets, params });
}

/** @returns an operation of another component that made assets. */
function made(id: string, time: number, outputs: ReturnType<typeof assetId>[]): Event {
  return stepEvent({ id, operation: "gen.make", time, outputs });
}

/** @returns the item as the reducer stores it, for a comparison that ignores absent fields. */
function item(fields: Partial<AssetItem> & Pick<AssetItem, "id" | "origin" | "record">): AssetItem {
  return {
    added_at: at(0),
    review: "adopted",
    folder: null,
    tags: [],
    ...fields,
  };
}

const create = (id: string, time: number, name: string, parent?: string): RecordSpec => ({
  id,
  operation: "asset.folder_create",
  time,
  params: parent === undefined ? { name } : { name, parent },
});

describe("the asset reducer", () => {
  it("starts empty", () => {
    expect(assetReducer.initial()).toEqual({ items: {}, folders: {}, marks: {} });
  });

  it("adds the outputs of a done record of any component as pending, and ignores unfinished records", () => {
    const slice = fold([
      makeRecord({ id: "g1", operation: "gen.make", time: 1, outputs: [A] }),
      makeRecord({ id: "g2", operation: "gen.make", time: 2, outputs: [B], status: "running" }),
      makeRecord({ id: "g3", operation: "gen.make", time: 3, outputs: [B], status: "failed" }),
    ]);
    expect(slice.items).toEqual({
      [A]: item({
        id: A,
        origin: "output",
        record: recordId("g1"),
        added_at: at(1),
        review: "pending",
      }),
    });
  });

  it("keeps an existing item when a later record outputs the same asset", () => {
    const slice = fold([
      makeRecord({ id: "g1", operation: "gen.make", time: 1, outputs: [A] }),
      makeRecord({
        id: "r1",
        operation: "asset.review",
        time: 2,
        assets: [A],
        params: { review: "held" },
      }),
      makeRecord({ id: "g2", operation: "gen.make", time: 3, outputs: [A] }),
    ]);
    expect(slice.items[A]).toMatchObject({ record: "g1", review: "held", reviewed_at: at(2) });
  });

  it("sets review, folder and tags of items, with tags trimmed, lower-cased, deduplicated and sorted", () => {
    const slice = fold([
      makeRecord({
        id: "f1",
        operation: "asset.folder_create",
        time: 1,
        params: { name: "Heroes" },
      }),
      makeRecord({ id: "g1", operation: "gen.make", time: 2, outputs: [A, B] }),
      makeRecord({
        id: "r1",
        operation: "asset.review",
        time: 3,
        assets: [A],
        params: { review: "adopted" },
      }),
      makeRecord({
        id: "m1",
        operation: "asset.move",
        time: 4,
        assets: [A, B],
        params: { folder: "f1" },
      }),
      makeRecord({
        id: "t1",
        operation: "asset.tag",
        time: 5,
        assets: [A],
        params: { add: [" Red ", "blue", "RED", "  "], remove: [] },
      }),
      makeRecord({
        id: "t2",
        operation: "asset.tag",
        time: 6,
        assets: [A],
        params: { add: ["green"], remove: ["BLUE"] },
      }),
      makeRecord({ id: "m2", operation: "asset.move", time: 7, assets: [B], params: {} }),
    ]);
    expect(slice.items[A]).toMatchObject({
      review: "adopted",
      reviewed_at: at(3),
      folder: "f1",
      tags: ["green", "red"],
    });
    expect(slice.items[B]).toMatchObject({ review: "pending", folder: null });
  });

  it("removes a tag before it adds, so a tag named in both stays", () => {
    const slice = fold([
      makeRecord({ id: "g1", operation: "gen.make", time: 1, outputs: [A] }),
      makeRecord({
        id: "t1",
        operation: "asset.tag",
        time: 2,
        assets: [A],
        params: { add: ["x"] },
      }),
      makeRecord({
        id: "t2",
        operation: "asset.tag",
        time: 3,
        assets: [A],
        params: { add: ["x"], remove: ["x"] },
      }),
    ]);
    expect(slice.items[A]?.tags).toEqual(["x"]);
  });

  it("deletes an asset and keeps only the time of the deletion", () => {
    const slice = fold([
      makeRecord({ id: "g1", operation: "gen.make", time: 1, outputs: [A] }),
      makeRecord({
        id: "t1",
        operation: "asset.tag",
        time: 2,
        assets: [A],
        params: { add: ["x"] },
      }),
      makeRecord({ id: "d1", operation: "asset.delete", time: 3, assets: [A] }),
    ]);
    expect(slice.items).toEqual({});
    expect(slice.marks).toEqual({ [A]: { deleted_at: at(3) } });
  });

  it("brings a deleted asset back as a new pending item when an operation outputs it again", () => {
    const slice = fold([
      makeRecord({ id: "g1", operation: "gen.make", time: 1, outputs: [A] }),
      makeRecord({
        id: "t1",
        operation: "asset.tag",
        time: 2,
        assets: [A],
        params: { add: ["x"] },
      }),
      makeRecord({ id: "d1", operation: "asset.delete", time: 3, assets: [A] }),
      makeRecord({ id: "g2", operation: "gen.make", time: 4, outputs: [A] }),
    ]);
    expect(slice.items[A]).toEqual(
      item({ id: A, origin: "output", record: recordId("g2"), added_at: at(4), review: "pending" }),
    );
  });

  describe("folders", () => {
    it("creates folders last among their siblings and trims the name", () => {
      const slice = fold(
        [
          create("f1", 1, "  Heroes "),
          create("f2", 2, "Villains"),
          create("f3", 3, "Boss", "f2"),
          create("f4", 4, "Minion", "f2"),
        ].map(makeRecord),
      );
      expect(slice.folders).toEqual({
        f1: { id: "f1", name: "Heroes", parent: null, position: 0 },
        f2: { id: "f2", name: "Villains", parent: null, position: 1 },
        f3: { id: "f3", name: "Boss", parent: "f2", position: 0 },
        f4: { id: "f4", name: "Minion", parent: "f2", position: 1 },
      });
    });

    it("renames a folder and moves it last among its new siblings; null moves it to the root", () => {
      const base = [create("f1", 1, "A"), create("f2", 2, "B"), create("f3", 3, "C", "f1")].map(
        makeRecord,
      );
      const renamed = fold([
        ...base,
        makeRecord({
          id: "u1",
          operation: "asset.folder_update",
          time: 4,
          params: { folder: "f1", name: "Alpha" },
        }),
      ]);
      expect(renamed.folders[recordId("f1")]).toMatchObject({ name: "Alpha", position: 0 });
      const moved = fold([
        ...base,
        makeRecord({
          id: "u1",
          operation: "asset.folder_update",
          time: 4,
          params: { folder: "f2", parent: "f1" },
        }),
        makeRecord({
          id: "u2",
          operation: "asset.folder_update",
          time: 5,
          params: { folder: "f3", parent: null },
        }),
      ]);
      expect(moved.folders[recordId("f2")]).toMatchObject({ parent: "f1", position: 1 });
      expect(moved.folders[recordId("f3")]).toMatchObject({ parent: null, position: 1 });
    });

    it("does not move a folder below itself", () => {
      const slice = fold([
        ...[create("f1", 1, "A"), create("f2", 2, "B", "f1")].map(makeRecord),
        makeRecord({
          id: "u1",
          operation: "asset.folder_update",
          time: 3,
          params: { folder: "f1", parent: "f2" },
        }),
      ]);
      expect(slice.folders[recordId("f1")]).toMatchObject({ parent: null });
    });

    it("deletes a folder with its subfolders and moves their assets and marks to the root", () => {
      const slice = fold([
        ...[create("f1", 1, "A"), create("f2", 2, "B", "f1"), create("f3", 3, "C")].map(makeRecord),
        makeRecord({ id: "g1", operation: "gen.make", time: 4, outputs: [A, B] }),
        makeRecord({
          id: "m1",
          operation: "asset.move",
          time: 5,
          assets: [A],
          params: { folder: "f2" },
        }),
        makeRecord({
          id: "m2",
          operation: "asset.move",
          time: 6,
          assets: [B],
          params: { folder: "f3" },
        }),
        // An asset whose import is still to come, filed in the doomed folder.
        makeRecord({
          id: "m3",
          operation: "asset.move",
          time: 7,
          assets: [assetId("c")],
          params: { folder: "f1" },
        }),
        makeRecord({
          id: "x1",
          operation: "asset.folder_delete",
          time: 8,
          params: { folder: "f1" },
        }),
      ]);
      expect(Object.keys(slice.folders)).toEqual(["f3"]);
      expect(slice.items[A]?.folder).toBeNull();
      expect(slice.items[B]?.folder).toBe("f3");
      expect(slice.marks[assetId("c")]).toEqual({ folder: null });
    });
  });

  it("skips a record whose params do not parse, and does not throw", () => {
    const slice = fold([
      makeRecord({ id: "g1", operation: "gen.make", time: 1, outputs: [A] }),
      makeRecord({
        id: "r1",
        operation: "asset.review",
        time: 2,
        assets: [A],
        params: { review: "pending" },
      }),
      makeRecord({ id: "r2", operation: "asset.review", time: 3, assets: [A], params: {} }),
      makeRecord({
        id: "m1",
        operation: "asset.move",
        time: 4,
        assets: [A],
        params: { folder: 5 },
      }),
      makeRecord({ id: "t1", operation: "asset.tag", time: 5, assets: [A], params: { add: "x" } }),
      makeRecord({ id: "f1", operation: "asset.folder_create", time: 6, params: {} }),
      makeRecord({ id: "f2", operation: "asset.folder_create", time: 7, params: { name: "  " } }),
      makeRecord({
        id: "u1",
        operation: "asset.folder_update",
        time: 8,
        params: { folder: "nope", name: "x" },
      }),
      makeRecord({ id: "x1", operation: "asset.folder_delete", time: 9, params: { folder: 1 } }),
    ]);
    expect(slice.items[A]).toEqual(
      item({ id: A, origin: "output", record: recordId("g1"), added_at: at(1), review: "pending" }),
    );
    expect(slice.folders).toEqual({});
  });

  it("changes nothing for a record of another operation without outputs", () => {
    const before = fold([makeRecord({ id: "g1", operation: "gen.make", time: 1, outputs: [A] })]);
    const after = assetReducer.reduce(
      before,
      makeRecord({ id: "n1", operation: "proj.rename", time: 2 }),
    );
    expect(after).toBe(before);
  });

  it("answers the agent summary: counts, folders sorted by path, cut at 40 with the rest counted", () => {
    expect(
      assetReducer.agentSummary?.(
        assetReducer.initial(),
        { url: (asset) => String(asset) },
        stateOf(undefined),
        SESSION,
      ),
    ).toEqual({});
    const records = [
      makeRecord({ id: "f1", operation: "asset.folder_create", time: 1, params: { name: "zeta" } }),
      makeRecord({
        id: "f2",
        operation: "asset.folder_create",
        time: 2,
        params: { name: "alpha", parent: "f1" },
      }),
      makeRecord({ id: "g1", operation: "gen.make", time: 3, outputs: [A, B] }),
      makeRecord({
        id: "r1",
        operation: "asset.review",
        time: 4,
        assets: [A],
        params: { review: "adopted" },
      }),
    ];
    const slice = fold(records);
    const summary = assetReducer.agentSummary?.(
      slice,
      { url: (asset) => String(asset) },
      stateOf(undefined),
      SESSION,
    );
    expect(summary).toEqual({
      assets: { adopted: 1, pending: 1, held: 0 },
      asset_folders: [
        { id: "f1", path: "zeta" },
        { id: "f2", path: "zeta/alpha" },
      ],
    });
    const many = fold(
      Array.from({ length: 45 }, (_, index) =>
        makeRecord({
          id: `f${String(index)}`,
          operation: "asset.folder_create",
          time: index,
          params: { name: `n${String(index).padStart(2, "0")}` },
        }),
      ),
    );
    const cut = assetReducer.agentSummary?.(
      many,
      { url: (asset) => String(asset) },
      stateOf(undefined),
      SESSION,
    );
    expect(cut?.["asset_folders_more"]).toBe(5);
    expect(cut).not.toHaveProperty("assets");
  });

  it("mentions the assets of the library", () => {
    const slice = fold([makeRecord({ id: "g1", operation: "gen.make", time: 1, outputs: [A, B] })]);
    expect(assetReducer.mentions?.(slice)).toEqual([A, B]);
    expect(assetReducer.mentions?.(undefined)).toEqual([]);
  });
});

/** One timeline: records with their real times, and what the library means in real time. */
interface Timeline {
  name: string;
  events: Event[];
  /** The items the library holds at the end, by asset. */
  items: Record<string, AssetItem>;
}

const F = "f1";
const folderCreate = (time: number): Event =>
  stepEvent({ id: F, operation: "asset.folder_create", time, params: { name: "Heroes" } });

const TIMELINES: Timeline[] = [
  {
    name: "import, then tag",
    events: [importEvent("i1", 1, [A]), step("t1", "asset.tag", 2, [A], { add: ["x"] })],
    items: {
      [A]: item({ id: A, origin: "import", record: recordId("i1"), added_at: at(1), tags: ["x"] }),
    },
  },
  {
    name: "import, tag, delete, import again",
    events: [
      importEvent("i1", 1, [A]),
      step("t1", "asset.tag", 2, [A], { add: ["x"] }),
      step("d1", "asset.delete", 3, [A]),
      importEvent("i4", 4, [A]),
    ],
    items: { [A]: item({ id: A, origin: "import", record: recordId("i4"), added_at: at(4) }) },
  },
  {
    name: "import, tag, delete, import again, tag again",
    events: [
      importEvent("i1", 1, [A]),
      step("t1", "asset.tag", 2, [A], { add: ["x"] }),
      step("d1", "asset.delete", 3, [A]),
      importEvent("i4", 4, [A]),
      step("t5", "asset.tag", 5, [A], { add: ["y"] }),
    ],
    items: {
      [A]: item({ id: A, origin: "import", record: recordId("i4"), added_at: at(4), tags: ["y"] }),
    },
  },
  {
    name: "import, then hold",
    events: [importEvent("i1", 1, [A]), step("r1", "asset.review", 2, [A], { review: "held" })],
    items: {
      [A]: item({
        id: A,
        origin: "import",
        record: recordId("i1"),
        added_at: at(1),
        review: "held",
        reviewed_at: at(2),
      }),
    },
  },
  {
    name: "output, import, then hold",
    events: [
      made("g1", 1, [A]),
      importEvent("i2", 2, [A]),
      step("r1", "asset.review", 3, [A], { review: "held" }),
    ],
    items: {
      [A]: item({
        id: A,
        origin: "output",
        record: recordId("g1"),
        added_at: at(1),
        review: "held",
        reviewed_at: at(3),
      }),
    },
  },
  {
    name: "output, then import: the import adopts it",
    events: [made("g1", 1, [A]), importEvent("i2", 2, [A])],
    items: {
      [A]: item({
        id: A,
        origin: "output",
        record: recordId("g1"),
        added_at: at(1),
        review: "adopted",
        reviewed_at: at(2),
      }),
    },
  },
  {
    name: "import, then an output of the same bytes",
    events: [importEvent("i1", 1, [A]), made("g2", 2, [A])],
    items: { [A]: item({ id: A, origin: "import", record: recordId("i1"), added_at: at(1) }) },
  },
  {
    name: "import, delete, then an output of the same bytes",
    events: [importEvent("i1", 1, [A]), step("d1", "asset.delete", 2, [A]), made("g3", 3, [A])],
    items: {
      [A]: item({
        id: A,
        origin: "output",
        record: recordId("g3"),
        added_at: at(3),
        review: "pending",
      }),
    },
  },
  {
    // The second output must not forget the deletion: the import came before it.
    name: "import, delete, then two outputs of the same bytes",
    events: [
      importEvent("i1", 1, [A]),
      step("d1", "asset.delete", 2, [A]),
      made("g3", 3, [A]),
      made("g4", 4, [A]),
    ],
    items: {
      [A]: item({
        id: A,
        origin: "output",
        record: recordId("g3"),
        added_at: at(3),
        review: "pending",
      }),
    },
  },
  {
    name: "output, delete, import",
    events: [made("g1", 1, [A]), step("d1", "asset.delete", 2, [A]), importEvent("i3", 3, [A])],
    items: { [A]: item({ id: A, origin: "import", record: recordId("i3"), added_at: at(3) }) },
  },
  {
    name: "import, file it in a folder",
    events: [
      folderCreate(0),
      importEvent("i1", 1, [A]),
      step("m1", "asset.move", 2, [A], { folder: F }),
    ],
    items: {
      [A]: item({
        id: A,
        origin: "import",
        record: recordId("i1"),
        added_at: at(1),
        folder: recordId(F),
      }),
    },
  },
  {
    name: "import, file it, delete the folder",
    events: [
      folderCreate(0),
      importEvent("i1", 1, [A]),
      step("m1", "asset.move", 2, [A], { folder: F }),
      step("x1", "asset.folder_delete", 3, [], { folder: F }),
    ],
    items: { [A]: item({ id: A, origin: "import", record: recordId("i1"), added_at: at(1) }) },
  },
  {
    name: "import, hold, import again",
    events: [
      importEvent("i1", 1, [A]),
      step("r1", "asset.review", 2, [A], { review: "held" }),
      importEvent("i3", 3, [A]),
    ],
    items: {
      [A]: item({
        id: A,
        origin: "import",
        record: recordId("i1"),
        added_at: at(1),
        review: "adopted",
        reviewed_at: at(3),
      }),
    },
  },
  {
    name: "import, tag, then an output of the same bytes",
    events: [
      importEvent("i1", 1, [A]),
      step("t1", "asset.tag", 2, [A], { add: ["x"] }),
      made("g3", 3, [A]),
    ],
    items: {
      [A]: item({ id: A, origin: "import", record: recordId("i1"), added_at: at(1), tags: ["x"] }),
    },
  },
  {
    name: "import, hold, then an output of the same bytes",
    events: [
      importEvent("i1", 1, [A]),
      step("r1", "asset.review", 2, [A], { review: "held" }),
      made("g3", 3, [A]),
    ],
    items: {
      [A]: item({
        id: A,
        origin: "import",
        record: recordId("i1"),
        added_at: at(1),
        review: "held",
        reviewed_at: at(2),
      }),
    },
  },
  {
    name: "output, adopt, import",
    events: [
      made("g1", 1, [A]),
      step("r1", "asset.review", 2, [A], { review: "adopted" }),
      importEvent("i3", 3, [A]),
    ],
    items: {
      [A]: item({
        id: A,
        origin: "output",
        record: recordId("g1"),
        added_at: at(1),
        review: "adopted",
        reviewed_at: at(3),
      }),
    },
  },
  {
    name: "import, delete, import, delete again",
    events: [
      importEvent("i1", 1, [A]),
      step("d1", "asset.delete", 2, [A]),
      importEvent("i3", 3, [A]),
      step("d2", "asset.delete", 4, [A]),
    ],
    items: {},
  },
  {
    name: "two assets: one deleted, one tagged",
    events: [
      importEvent("i1", 1, [A, B]),
      step("d1", "asset.delete", 2, [A]),
      step("t1", "asset.tag", 3, [B], { add: ["keep"] }),
    ],
    items: {
      [B]: item({
        id: B,
        origin: "import",
        record: recordId("i1"),
        added_at: at(1),
        tags: ["keep"],
      }),
    },
  },
];

describe("the order of imports", () => {
  it.each(TIMELINES)(
    "gives the real-time result in the registry's order: $name",
    ({ events, items }) => {
      const registry = reduceRegistryOrder(events);
      expect(registry.items).toEqual(items);
      const realTime = reduceRealTimeOrder(events);
      expect(realTime.items).toEqual(registry.items);
      expect(realTime.folders).toEqual(registry.folders);
    },
  );

  it("drops a mark once its asset has been imported", () => {
    const slice = reduceRegistryOrder([
      importEvent("i1", 1, [A]),
      step("t1", "asset.tag", 2, [A], { add: ["x"] }),
    ]);
    expect(slice.marks).toEqual({});
  });
});
