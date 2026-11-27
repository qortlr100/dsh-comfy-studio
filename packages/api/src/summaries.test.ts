import { describe, expect, it, vi } from "vitest";
import type { AssetId, ProjectId } from "@cs/project";
import { defined, standIn } from "@cs/project/testing/support";
import { summarizeProject } from "./summaries.ts";
import { asRecord, mountApi, ROUTES } from "./testing/support.ts";

const PROJECT = standIn<ProjectId>("p");

/**
 * @param records - fake records: `{status, outputs, created_at, finished_at?}`.
 * @returns a state the summary can read.
 */
function stateOf(records: Array<Record<string, unknown>>): Parameters<typeof summarizeProject>[1] {
  return standIn({ components: { proj: { records } } });
}

/**
 * @param mimes - MIME type by asset ID.
 * @returns a MIME lookup that answers null for an unknown asset.
 */
function mimeFrom(mimes: Record<string, string>): (id: AssetId) => string | null {
  return (id) => mimes[id] ?? null;
}

describe("summarizeProject", () => {
  it("returns an empty summary for a state with no records", () => {
    expect(summarizeProject(PROJECT, stateOf([]), mimeFrom({}))).toEqual({
      project: "p",
      cover: null,
      edited_at: null,
    });
  });

  it("covers with the first image output of a finished record", () => {
    const state = stateOf([
      { status: "done", outputs: ["v1", "i1", "i2"], created_at: "t1" },
      { status: "done", outputs: ["i3"], created_at: "t2" },
    ]);
    const summary = summarizeProject(
      PROJECT,
      state,
      mimeFrom({ v1: "video/mp4", i1: "image/png", i2: "image/jpeg", i3: "image/png" }),
    );
    expect(summary.cover).toEqual({ asset: "i1", mime: "image/png" });
  });

  it("skips non-image outputs and assets the store does not hold", () => {
    const state = stateOf([{ status: "done", outputs: ["v1", "gone", "t1"], created_at: "t1" }]);
    const summary = summarizeProject(
      PROJECT,
      state,
      mimeFrom({ v1: "video/mp4", t1: "text/plain" }),
    );
    expect(summary.cover).toBeNull();
  });

  it("skips records that have not finished done", () => {
    const state = stateOf([
      { status: "pending", outputs: ["i1"], created_at: "t1" },
      { status: "running", outputs: ["i2"], created_at: "t2" },
      { status: "failed", outputs: ["i3"], created_at: "t3" },
      { status: "cancelled", outputs: ["i4"], created_at: "t4" },
      { status: "done", outputs: ["i5"], created_at: "t5" },
    ]);
    const mimes = Object.fromEntries(["i1", "i2", "i3", "i4", "i5"].map((id) => [id, "image/png"]));
    expect(summarizeProject(PROJECT, state, mimeFrom(mimes)).cover).toEqual({
      asset: "i5",
      mime: "image/png",
    });
  });

  it("dates the last edit by the last record's finished_at, else its created_at", () => {
    const finished = stateOf([
      { status: "done", outputs: [], created_at: "2026-01-01T00:00:00Z" },
      {
        status: "done",
        outputs: [],
        created_at: "2026-01-02T00:00:00Z",
        finished_at: "2026-01-03T00:00:00Z",
      },
    ]);
    expect(summarizeProject(PROJECT, finished, mimeFrom({})).edited_at).toBe(
      "2026-01-03T00:00:00Z",
    );
    const pending = stateOf([
      {
        status: "done",
        outputs: [],
        created_at: "2026-01-01T00:00:00Z",
        finished_at: "2026-01-01T00:00:01Z",
      },
      { status: "pending", outputs: [], created_at: "2026-01-02T00:00:00Z" },
    ]);
    expect(summarizeProject(PROJECT, pending, mimeFrom({})).edited_at).toBe("2026-01-02T00:00:00Z");
  });
});

describe("GET /api/cs/projects/summary", () => {
  it("summarizes every project in the order of the project list, with the cover and edit time", async () => {
    const f = await mountApi();
    const plain = await f.newProject("Plain");
    const covered = await f.newProject("Covered");
    const snap = await f.api.runOperation({ project: covered, operation: "probe_note.snap" });
    const result = await f.call(ROUTES.projectSummaries);
    expect(result.status).toBe(200);
    const summaries = standIn<Array<Record<string, unknown>>>(result.json);
    expect(summaries.map((summary) => summary["project"])).toEqual(
      f.project.listProjects().map((info) => info.id),
    );
    const byProject = new Map(summaries.map((summary) => [summary["project"], summary]));
    expect(byProject.get(covered)).toEqual({
      project: covered,
      cover: { asset: snap.outputs[0], mime: "image/png" },
      edited_at: snap.finished_at,
    });
    const first = defined(f.project.getState(plain).components.proj.records[0]);
    expect(byProject.get(plain)).toEqual({
      project: plain,
      cover: null,
      edited_at: first.finished_at ?? first.created_at,
    });
  });

  it("summarizes the one project the request names", async () => {
    const f = await mountApi();
    await f.newProject("Other");
    const one = await f.newProject("One");
    const result = await f.call(ROUTES.projectSummaries, { query: { project: one } });
    expect(standIn<unknown[]>(result.json)).toHaveLength(1);
    expect(asRecord(standIn<unknown[]>(result.json)[0])["project"]).toBe(one);
    const unknown = await f.call(ROUTES.projectSummaries, { query: { project: "nothing" } });
    expect(unknown.status).toBe(404);
    expect(asRecord(unknown.json)["code"]).toBe("unknown_project");
    const malformed = await f.call(ROUTES.projectSummaries, { query: { project: "bad id!" } });
    expect(malformed.status).toBe(400);
  });

  it("gives a project whose state cannot be read the empty entry while the others still arrive", async () => {
    const f = await mountApi();
    const good = await f.newProject("Good");
    const broken = await f.newProject("Broken");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const original = f.project.getState.bind(f.project);
    vi.spyOn(f.project, "getState").mockImplementation((id) => {
      if (id === broken) throw new Error("unreadable");
      return original(id);
    });
    const result = await f.call(ROUTES.projectSummaries);
    expect(result.status).toBe(200);
    const byProject = new Map(
      standIn<Array<Record<string, unknown>>>(result.json).map((summary) => [
        summary["project"],
        summary,
      ]),
    );
    expect(byProject.get(broken)).toEqual({ project: broken, cover: null, edited_at: null });
    expect(asRecord(byProject.get(good))["edited_at"]).toEqual(expect.any(String));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreadable"));
    // Asked for by name, the failure is the request's.
    const single = await f.call(ROUTES.projectSummaries, { query: { project: broken } });
    expect(single.status).toBe(500);
    expect(asRecord(single.json)["code"]).toBe("internal_error");
  });

  it("answers an empty list when there are no projects", async () => {
    const f = await mountApi();
    expect(await f.call(ROUTES.projectSummaries)).toEqual({ status: 200, json: [] });
  });
});
