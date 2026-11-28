/**
 * Tests of the asset operations over the real project layer: the operation table, the refusals before a record is
 * written, import outside the history, undo, agent permissions, and `asset.list` through `run`.
 */
import { describe, expect, it } from "vitest";
import type { AssetId, RecordId, RunResult } from "@cs/project/types";
import { mount } from "./testing/operations.ts";
import { ASSET_OPERATIONS } from "./types.ts";

type Mounted = Awaited<ReturnType<typeof mount>>;

/** @returns the refusal's code of a rejected promise. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("Expected the call to be refused.");
}

/** @returns the tags `<prefix>0` to `<prefix><count - 1>`. */
function tags(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i)}`);
}

/** A library of two imported assets and one pending output. */
async function library(): Promise<{ f: Mounted; a: AssetId; b: AssetId; g: AssetId }> {
  const f = await mount();
  const a = f.stored("one");
  const b = f.stored("two");
  await f.run("asset.import", {}, { role: "file", assets: [a, b] });
  const g = f.defined((await f.runGenerate("gen")).outputs[0]);
  return { f, a, b, g };
}

describe("the operation table", () => {
  it("declares the nine operations with their agent values and flags", async () => {
    const f = await mount();
    const table = Object.fromEntries(
      f.operations.map((spec) => [
        spec.name,
        {
          agent: spec.agent ?? "run",
          readOnly: spec.readOnly === true,
          outsideHistory: spec.outsideHistory === true,
        },
      ]),
    );
    const plain = { readOnly: false, outsideHistory: false };
    expect(table).toEqual({
      "asset.import": { agent: "none", readOnly: false, outsideHistory: true },
      "asset.review": { agent: "none", ...plain },
      "asset.move": { agent: "run", ...plain },
      "asset.tag": { agent: "run", ...plain },
      "asset.delete": { agent: "propose", ...plain },
      "asset.folder_create": { agent: "run", ...plain },
      "asset.folder_update": { agent: "run", ...plain },
      "asset.folder_delete": { agent: "propose", ...plain },
      "asset.list": { agent: "run", readOnly: true, outsideHistory: false },
    });
    expect(Object.values(ASSET_OPERATIONS).toSorted()).toEqual(Object.keys(table).toSorted());
    for (const spec of f.operations) {
      expect([spec.component, spec.version, spec.resource, spec.deterministic]).toEqual([
        "asset",
        "1",
        "none",
        false,
      ]);
      expect(spec.description.split(/\s+/).length).toBeLessThanOrEqual(80);
    }
  });
});

describe("asset.import", () => {
  it("brings stored files in as adopted assets outside the history, and undo keeps them", async () => {
    const f = await mount();
    const a = f.stored("one");
    const b = f.stored("two");

    const result = await f.run("asset.import", {}, { role: "file", assets: [a, b] });
    const record = f.defined(result.record);
    expect(record.status).toBe("done");
    expect(result.outputs).toEqual([a, b]);
    expect(f.imports).toEqual([
      { path: `/store/${a}`, mime: "image/png", name: "one.png" },
      { path: `/store/${b}`, mime: "image/png", name: "two.png" },
    ]);
    expect(f.library().items[a]).toMatchObject({
      origin: "import",
      review: "adopted",
      record: record.id,
    });
    // Not a step: the history list holds only the project's first record.
    expect(f.history()).toEqual(["proj.create"]);

    await f.run("asset.tag", { add: ["keep"] }, { assets: [a] });
    expect(f.library().items[a]?.tags).toEqual(["keep"]);
    await f.undo();
    expect(f.library().items[a]).toMatchObject({ origin: "import", review: "adopted", tags: [] });
    expect(Object.keys(f.library().items).toSorted()).toEqual([a, b].toSorted());
  });

  it("refuses a file the store does not hold, writing nothing", async () => {
    const f = await mount();
    const known = f.stored("one");
    const before = f.count();
    const unlisted = await refusal(
      f.run("asset.import", {}, { role: "file", assets: [known, f.unlisted("ghost")] }),
    );
    expect(unlisted.code).toBe("invalid_inputs");
    // The project layer itself refuses an ID it has never seen.
    const loose = await refusal(
      f.run("asset.import", {}, { role: "file", assets: [known, f.loose("ghost")] }),
    );
    expect(loose.code).toBe("unknown_asset");
    expect(f.count()).toBe(before);
  });

  it("is refused for an agent", async () => {
    const f = await mount();
    const a = f.stored("one");
    const failure = await refusal(
      f.run("asset.import", {}, { role: "file", assets: [a], agent: true }),
    );
    expect(failure.code).toBe("agent_not_allowed");
  });
});

describe("the operations that change the library", () => {
  it("reviews assets as the user, and refuses an agent", async () => {
    const { f, a, g } = await library();
    expect(f.library().items[g]?.review).toBe("pending");
    await f.run("asset.review", { review: "adopted" }, { assets: [g] });
    await f.run("asset.review", { review: "held" }, { assets: [a] });
    expect(f.library().items[g]).toMatchObject({ review: "adopted" });
    expect(f.library().items[a]).toMatchObject({ review: "held" });

    const before = f.count();
    expect(
      (await refusal(f.run("asset.review", { review: "held" }, { assets: [g], agent: true }))).code,
    ).toBe("agent_not_allowed");
    expect(f.count()).toBe(before);
  });

  it("creates, updates and moves folders, then files assets into them", async () => {
    const { f, a, b } = await library();
    const heroes = f.id((await f.run("asset.folder_create", { name: " Heroes " })).record);
    const kids = f.id(
      (await f.run("asset.folder_create", { name: "Kids", parent: heroes })).record,
    );
    await f.run("asset.move", { folder: kids }, { assets: [a, b] });
    expect(f.library().items[a]?.folder).toBe(kids);
    await f.run("asset.folder_update", { folder: kids, name: "Small" });
    expect(f.library().folders[kids]).toMatchObject({ name: "Small", parent: heroes, position: 0 });
    await f.run("asset.folder_update", { folder: kids, parent: null });
    expect(f.library().folders[kids]).toMatchObject({ parent: null, position: 1 });
    await f.run("asset.move", {}, { assets: [a] });
    expect(f.library().items[a]?.folder).toBeNull();
    expect(f.library().items[b]?.folder).toBe(kids);
  });

  it("tags assets and normalizes the tags", async () => {
    const { f, a } = await library();
    await f.run("asset.tag", { add: [" Blue ", "red"] }, { assets: [a] });
    await f.run("asset.tag", { remove: ["BLUE"] }, { assets: [a] });
    expect(f.library().items[a]?.tags).toEqual(["red"]);
  });

  it("proposes a deletion for an agent and deletes as the user, which undo restores", async () => {
    const { f, a } = await library();
    const failure = await refusal(f.run("asset.delete", {}, { assets: [a], agent: true }));
    expect(failure.code).toBe("agent_not_allowed");
    expect(
      (await refusal(f.run("asset.folder_delete", { folder: "x" }, { agent: true }))).code,
    ).toBe("agent_not_allowed");

    const proposal = await f.propose("asset.delete", {}, { assets: [a] });
    expect(proposal.operation).toBe("proj.propose");
    expect(f.library().items[a]).toBeDefined();

    await f.run("asset.tag", { add: ["x"] }, { assets: [a] });
    await f.run("asset.delete", {}, { assets: [a] });
    expect(f.library().items[a]).toBeUndefined();
    await f.undo();
    expect(f.library().items[a]).toMatchObject({ tags: ["x"], review: "adopted" });
  });

  it("deletes a folder as the user; its assets go to the root", async () => {
    const { f, a } = await library();
    const folder = f.id((await f.run("asset.folder_create", { name: "Old" })).record);
    await f.run("asset.move", { folder }, { assets: [a] });
    await f.run("asset.folder_delete", { folder });
    expect(f.library().folders).toEqual({});
    expect(f.library().items[a]?.folder).toBeNull();
    await f.undo();
    expect(f.library().items[a]?.folder).toBe(folder);
  });

  it("lets an agent run move, tag and folder creation", async () => {
    const { f, a } = await library();
    const folder = f.id(
      (await f.run("asset.folder_create", { name: "Agent" }, { agent: true })).record,
    );
    await f.run("asset.move", { folder }, { assets: [a], agent: true });
    await f.run("asset.tag", { add: ["seen"] }, { assets: [a], agent: true });
    expect(f.library().items[a]).toMatchObject({ folder, tags: ["seen"] });
  });

  describe("refuses before it writes a record", () => {
    /** The IDs the cases build on: an asset, a pending output, a folder with a subfolder, and another folder. */
    interface Ids {
      a: AssetId;
      g: AssetId;
      folder: RecordId;
      child: RecordId;
      other: RecordId;
    }
    /** One refused call: how it is made and what the refusal is. */
    interface Case {
      name: string;
      code: "invalid_inputs" | "invalid_params";
      /** Builds more state first; what it returns reaches `run` as `extra`. */
      setup?: (f: Mounted, ids: Ids) => Promise<RecordId>;
      run: (f: Mounted, ids: Ids, extra: RecordId) => Promise<RunResult>;
    }
    const cases: Case[] = [
      {
        name: "review of an asset that is not in the library",
        code: "invalid_inputs",
        run: (f) => f.run("asset.review", { review: "held" }, { assets: [f.stored("lone")] }),
      },
      {
        name: "review with a state a person cannot set",
        code: "invalid_params",
        run: (f, { a }) => f.run("asset.review", { review: "pending" }, { assets: [a] }),
      },
      {
        name: "move of an asset that is not in the library",
        code: "invalid_inputs",
        run: (f) => f.run("asset.move", {}, { assets: [f.stored("lone")] }),
      },
      {
        name: "move into a folder that does not exist",
        code: "invalid_params",
        run: (f, { a }) => f.run("asset.move", { folder: "nope" }, { assets: [a] }),
      },
      {
        name: "tag of an asset that is not in the library",
        code: "invalid_inputs",
        run: (f) => f.run("asset.tag", { add: ["x"] }, { assets: [f.stored("lone")] }),
      },
      {
        name: "tag without add or remove",
        code: "invalid_params",
        run: (f, { a }) => f.run("asset.tag", {}, { assets: [a] }),
      },
      {
        name: "tag with empty lists",
        code: "invalid_params",
        run: (f, { a }) => f.run("asset.tag", { add: [], remove: [] }, { assets: [a] }),
      },
      {
        name: "an empty tag",
        code: "invalid_params",
        run: (f, { a }) => f.run("asset.tag", { add: ["  "] }, { assets: [a] }),
      },
      {
        name: "a tag of 41 characters",
        code: "invalid_params",
        run: (f, { a }) => f.run("asset.tag", { add: ["x".repeat(41)] }, { assets: [a] }),
      },
      {
        name: "a tag with a comma",
        code: "invalid_params",
        run: (f, { a }) => f.run("asset.tag", { add: ["a,b"] }, { assets: [a] }),
      },
      {
        name: "21 tags to add",
        code: "invalid_params",
        run: (f, { a }) => f.run("asset.tag", { add: tags("t", 21) }, { assets: [a] }),
      },
      {
        name: "21 tags to remove",
        code: "invalid_params",
        run: (f, { a }) => f.run("asset.tag", { remove: tags("t", 21) }, { assets: [a] }),
      },
      {
        name: "delete of an asset that is not in the library",
        code: "invalid_inputs",
        run: (f) => f.run("asset.delete", {}, { assets: [f.stored("lone")] }),
      },
      {
        name: "a folder name of 0 characters",
        code: "invalid_params",
        run: (f) => f.run("asset.folder_create", { name: "   " }),
      },
      {
        name: "a folder name of 101 characters",
        code: "invalid_params",
        run: (f) => f.run("asset.folder_create", { name: "n".repeat(101) }),
      },
      {
        name: "a folder name with a slash",
        code: "invalid_params",
        run: (f) => f.run("asset.folder_create", { name: "a/b" }),
      },
      {
        name: "a folder name with a backslash",
        code: "invalid_params",
        run: (f) => f.run("asset.folder_create", { name: "a\\b" }),
      },
      {
        name: "a sibling with the same name in another case",
        code: "invalid_params",
        run: (f) => f.run("asset.folder_create", { name: "TOP" }),
      },
      {
        name: "a folder under a parent that does not exist",
        code: "invalid_params",
        run: (f) => f.run("asset.folder_create", { name: "x", parent: "nope" }),
      },
      {
        name: "a fifth level of folders",
        code: "invalid_params",
        // `other` is level 1; this makes levels 2 to 4.
        setup: async (f, { other }) => {
          let parent = other;
          for (const name of ["l2", "l3", "l4"]) {
            parent = f.id((await f.run("asset.folder_create", { name, parent })).record);
          }
          return parent;
        },
        run: (f, _ids, extra) => f.run("asset.folder_create", { name: "l5", parent: extra }),
      },
      {
        name: "an update of a folder that does not exist",
        code: "invalid_params",
        run: (f) => f.run("asset.folder_update", { folder: "nope", name: "x" }),
      },
      {
        name: "an update that changes nothing",
        code: "invalid_params",
        run: (f, { folder }) => f.run("asset.folder_update", { folder }),
      },
      {
        name: "a rename to a sibling's name",
        code: "invalid_params",
        run: (f, { folder }) => f.run("asset.folder_update", { folder, name: "other" }),
      },
      {
        name: "a move of a folder into itself",
        code: "invalid_params",
        run: (f, { folder }) => f.run("asset.folder_update", { folder, parent: folder }),
      },
      {
        name: "a move of a folder into its subfolder",
        code: "invalid_params",
        run: (f, { folder, child }) => f.run("asset.folder_update", { folder, parent: child }),
      },
      {
        name: "a move that is too deep once its subfolders count",
        code: "invalid_params",
        // `other` > x > y is three levels; `folder` with its `child` would add two more.
        setup: async (f, { other }) => {
          const x = f.id((await f.run("asset.folder_create", { name: "x", parent: other })).record);
          return f.id((await f.run("asset.folder_create", { name: "y", parent: x })).record);
        },
        run: (f, { folder }, extra) => f.run("asset.folder_update", { folder, parent: extra }),
      },
      {
        name: "a folder delete of a folder that does not exist",
        code: "invalid_params",
        run: (f) => f.run("asset.folder_delete", { folder: "nope" }),
      },
      {
        name: "a list of a folder that does not exist",
        code: "invalid_params",
        run: (f) => f.run("asset.list", { folder: "nope" }),
      },
      {
        name: "a list with a bad cursor",
        code: "invalid_params",
        run: (f) => f.run("asset.list", { cursor: "!!" }),
      },
      {
        name: "a list with six tags",
        code: "invalid_params",
        run: (f) => f.run("asset.list", { tags: tags("t", 6) }),
      },
      {
        name: "a list with nine words",
        code: "invalid_params",
        run: (f) => f.run("asset.list", { q: "a b c d e f g h i" }),
      },
    ];

    it.each(cases)("$name", async ({ run, setup, code }) => {
      const f = await mount();
      const a = f.stored("one");
      await f.run("asset.import", {}, { role: "file", assets: [a] });
      const g = f.defined((await f.runGenerate("gen")).outputs[0]);
      const folder = f.id((await f.run("asset.folder_create", { name: "top" })).record);
      const other = f.id((await f.run("asset.folder_create", { name: "other" })).record);
      const child = f.id(
        (await f.run("asset.folder_create", { name: "child", parent: folder })).record,
      );
      const ids = { a, g, folder, child, other };
      const extra = setup === undefined ? folder : await setup(f, ids);
      const before = f.count();
      const failure = await refusal(run(f, ids, extra));
      expect(failure.code).toBe(code);
      expect(failure.message.length).toBeGreaterThan(10);
      expect(f.count()).toBe(before);
    });

    it("refuses a 51st tag on one asset", async () => {
      const f = await mount();
      const a = f.stored("one");
      await f.run("asset.import", {}, { role: "file", assets: [a] });
      for (let batch = 0; batch < 2; batch += 1) {
        const add = Array.from({ length: 20 }, (_, i) => `t${String(batch * 20 + i)}`);
        await f.run("asset.tag", { add }, { assets: [a] });
      }
      await f.run(
        "asset.tag",
        { add: Array.from({ length: 10 }, (_, i) => `u${String(i)}`) },
        { assets: [a] },
      );
      expect(f.library().items[a]?.tags).toHaveLength(50);
      const before = f.count();
      const failure = await refusal(f.run("asset.tag", { add: ["one-more"] }, { assets: [a] }));
      expect(failure.code).toBe("invalid_params");
      expect(f.count()).toBe(before);
      // A tag the asset already has, or one that makes room, is fine.
      await f.run("asset.tag", { add: ["t0"] }, { assets: [a] });
      await f.run("asset.tag", { add: ["one-more"], remove: ["t1"] }, { assets: [a] });
    });

    it("accepts a move of a folder with a subfolder that fits within four levels", async () => {
      const f = await mount();
      const one = f.id((await f.run("asset.folder_create", { name: "one" })).record);
      const two = f.id((await f.run("asset.folder_create", { name: "two", parent: one })).record);
      const solo = f.id((await f.run("asset.folder_create", { name: "solo" })).record);
      const kid = f.id((await f.run("asset.folder_create", { name: "kid", parent: solo })).record);
      // `solo` spans two levels; under `two` (depth 2) it spans levels 3 and 4.
      await f.run("asset.folder_update", { folder: solo, parent: two });
      expect(f.library().folders[kid]).toMatchObject({ parent: solo });
      expect(f.library().folders[solo]).toMatchObject({ parent: two });
    });

    it("accepts a {record, output} input that names an output of an earlier record", async () => {
      const f = await mount();
      const made = await f.runGenerate("gen");
      const out = f.defined(made.outputs[0]);
      expect(f.library().items[out]?.review).toBe("pending");
      await f.runRaw({
        operation: "asset.review",
        params: { review: "adopted" },
        inputs: [{ role: "asset", ref: { record: f.id(made.record), output: 0 } }],
      });
      expect(f.library().items[out]?.review).toBe("adopted");
    });
  });
});

describe("asset.list", () => {
  it("answers through run without writing a record", async () => {
    const f = await mount();
    const a = f.stored("one");
    const b = f.stored("two");
    await f.run("asset.import", {}, { role: "file", assets: [a, b] });
    const before = f.count();
    await f.run("asset.tag", { add: ["hero"] }, { assets: [a] });
    const afterTag = f.count();

    const result = await f.run("asset.list", { tags: ["hero"] });
    expect(result.record).toBeNull();
    expect(f.count()).toBe(afterTag);
    expect(afterTag).toBe(before + 1);
    const report = f.report(result);
    expect(report.items.map((entry) => entry.id)).toEqual([a]);
    expect(report.items[0]).toMatchObject({
      name: "one.png",
      url: `/api/cs/asset?id=${a}`,
      tags: ["hero"],
    });
    expect(report.next_cursor).toBeNull();

    const page = f.report(await f.run("asset.list", { limit: 1 }));
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
    const rest = f.report(await f.run("asset.list", { limit: 1, cursor: page.next_cursor }));
    expect([...page.items, ...rest.items].map((entry) => entry.id).toSorted()).toEqual(
      [a, b].toSorted(),
    );
  });

  it("is open to an agent and names the tool of the operation that made an asset", async () => {
    const f = await mount();
    const made = await f.runGenerate("gen");
    const out = f.defined(made.outputs[0]);
    const report = f.report(await f.run("asset.list", { review: "pending" }, { agent: true }));
    expect(report.items).toMatchObject([{ id: out, made_by: "cs_image_make", origin: "output" }]);
  });
});

describe("references the preconditions cannot resolve", () => {
  const CALLS: Array<[string, Record<string, unknown>]> = [
    ["asset.tag", { add: ["x"] }],
    ["asset.move", {}],
    ["asset.delete", {}],
    ["asset.review", { review: "held" }],
  ];

  it.each(CALLS)(
    "%s refuses a reference to an import record outside the history",
    async (operation, params) => {
      const f = await mount();
      const a = f.stored("one");
      const imported = f.id(
        (await f.run("asset.import", {}, { role: "file", assets: [a] })).record,
      );
      // The reducer orders a delete after an import by timestamp, so the two must not share a millisecond.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await f.run("asset.delete", {}, { assets: [a] });
      const before = f.count();
      const failure = await refusal(
        f.runRaw({
          operation,
          params,
          inputs: [{ role: "asset", ref: { record: imported, output: 0 } }],
        }),
      );
      expect(failure.code).toBe("invalid_inputs");
      expect(failure.message).toContain("asset ID");
      expect(f.count()).toBe(before);
      expect(f.library().items[a]).toBeUndefined();
    },
  );

  it.each(CALLS)(
    "%s refuses a reference to the output of an undone step",
    async (operation, params) => {
      const f = await mount();
      const made = await f.runGenerate("gen");
      const step = f.id(made.record);
      await f.undo();
      const before = f.count();
      const failure = await refusal(
        f.runRaw({
          operation,
          params,
          inputs: [{ role: "asset", ref: { record: step, output: 0 } }],
        }),
      );
      expect(failure.code).toBe("invalid_inputs");
      expect(f.count()).toBe(before);
    },
  );

  it.each(CALLS)(
    "%s still accepts a reference to a step in the current history",
    async (operation, params) => {
      const f = await mount();
      const made = await f.runGenerate("gen");
      const before = f.count();
      await f.runRaw({
        operation,
        params,
        inputs: [{ role: "asset", ref: { record: f.id(made.record), output: 0 } }],
      });
      expect(f.count()).toBe(before + 1);
    },
  );
});
