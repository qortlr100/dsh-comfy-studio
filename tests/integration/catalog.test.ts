// The generation catalog (@cs/catalog) served by a real dsh through our bundle: the row mounts
// the service, a provider plugin's entry shows in the view API, a change of the catalog arrives
// on the event stream, and an operation runs a graph on an entry. Spec: docs/archive/PLAN_2-1.md
// "시험".

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { openPage } from "../harness/browser.ts";
import { launchDsh, tempParent } from "../harness/dsh.ts";
import { ADD, FIRST_TARGET, PROVIDER, REMOVE, RUN } from "./fixtures/catalog-provider.ts";

const PROVIDER_PATH = fileURLToPath(new URL("./fixtures/catalog-provider.ts", import.meta.url));

interface Answer {
  status: number;
  body: unknown;
}

/** What the page script reports back. */
interface PageReport {
  catalogBefore: Answer;
  add: Answer;
  catalogAfterAdd: Answer;
  run: Answer;
  remove: Answer;
  catalogAfterRemove: Answer;
  /** The kinds of the stream events after `ready`, in arrival order. */
  kinds: string[];
}

// Runs inside the page, where `fetch` carries the login cookie. A string, because the test
// program is type-checked without the DOM library.
const PAGE_SCRIPT = `(async () => {
  const answerOf = async (response) => ({ status: response.status, body: await response.json() });
  const get = async (path) => answerOf(await fetch(path));
  const post = async (path, body) =>
    answerOf(
      await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const kinds = [];
  const seen = (test) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (test()) resolve();
        else if (Date.now() - started > 10000) reject(new Error("stream timeout: " + JSON.stringify(kinds)));
        else setTimeout(tick, 20);
      };
      tick();
    });
  const catalogEvents = () => kinds.filter((kind) => kind === "catalog").length;

  const catalogBefore = await get("/api/cs/catalog");
  const created = await post("/api/cs/projects", { title: "Catalog probe" });
  const project = created.body.id;
  const operate = (operation, target) =>
    post("/api/cs/operation", { project, operation, params: { target }, surface: "view" });

  const source = new EventSource("/cs/events?project=" + project);
  let ready = false;
  source.addEventListener("ready", () => { ready = true; });
  for (const kind of ["catalog", "record", "update", "line"]) {
    source.addEventListener(kind, () => { if (ready) kinds.push(kind); });
  }
  try {
    await seen(() => ready);

    const add = await operate(${JSON.stringify(ADD)}, "two");
    await seen(() => catalogEvents() >= 1);
    const catalogAfterAdd = await get("/api/cs/catalog");

    const run = await operate(${JSON.stringify(RUN)}, "two");

    const remove = await operate(${JSON.stringify(REMOVE)}, "two");
    await seen(() => catalogEvents() >= 2);
    const catalogAfterRemove = await get("/api/cs/catalog");
    return { catalogBefore, add, catalogAfterAdd, run, remove, catalogAfterRemove, kinds };
  } finally {
    source.close();
  }
})()`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A patch that adds the fixture provider as one row. */
function providerPatch(): string {
  const dir = mkdtempSync(join(tempParent(), "cs-dsh-test-patch-"));
  dirs.push(dir);
  const patch = join(dir, "catalog.patch.yml");
  writeFileSync(
    patch,
    JSON.stringify([{ insert: [{ id: "cs-test-catalog", name: PROVIDER_PATH }] }]),
  );
  return patch;
}

/** The fixture's first entry as the view API lists it. */
const FIRST_ENTRY = {
  primitive: "graph",
  provider: PROVIDER,
  target: FIRST_TARGET,
  description: "A fake server for tests.",
  abilities: ["listModelFiles", "listRuns", "modelFileMetadata", "nodeCatalog"],
  facts: { label: "Fake server", kind: "fake", system: { version: "0.0.0" } },
  problem: null,
};

describe("generation catalog", () => {
  test("a page lists a provider's entries, sees the catalog change, and an operation runs on an entry", async () => {
    const dsh = await launchDsh({ patches: [providerPatch()] });
    try {
      const session = await openPage(dsh.url);
      try {
        const report = await session.page.evaluate<PageReport>(PAGE_SCRIPT);

        // The bundle's row mounted the catalog, and the provider plugin's entry is in it.
        expect(report.catalogBefore).toEqual({ status: 200, body: [FIRST_ENTRY] });

        // A second entry registered while the page listens: the stream says so, the list has it.
        expect(report.add).toMatchObject({ status: 200, body: { status: "done" } });
        expect(report.catalogAfterAdd.body).toEqual([
          FIRST_ENTRY,
          expect.objectContaining({ provider: PROVIDER, target: "two", abilities: [] }),
        ]);

        // An operation found the entry by its key and read its run to the end.
        expect(report.run).toMatchObject({
          status: 200,
          body: {
            operation: RUN,
            status: "done",
            report: {
              run: "fake-run-1",
              kinds: ["queued", "progress", "output", "done"],
              files: 1,
            },
          },
        });

        // Removed again: one more catalog event, and the list is back to the first entry.
        expect(report.remove).toMatchObject({ status: 200, body: { status: "done" } });
        expect(report.catalogAfterRemove).toEqual({ status: 200, body: [FIRST_ENTRY] });
        expect(report.kinds.filter((kind) => kind === "catalog")).toHaveLength(2);
      } finally {
        await session.close();
      }
    } finally {
      await dsh.stop();
    }
  });
});
