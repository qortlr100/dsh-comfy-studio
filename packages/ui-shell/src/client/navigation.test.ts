import { describe, expect, it } from "vitest";
import {
  followMainSession,
  listedOrHome,
  pickSession,
  projectOfSession,
  projectSessions,
  visibleSessions,
  type SessionInfo,
  type WorkspaceRow,
} from "./navigation.ts";

const s = (id: string, updatedAt: number, blank = false): SessionInfo => ({
  id,
  updatedAt,
  blank,
});

describe("projectOfSession", () => {
  const workspaces: WorkspaceRow[] = [
    { workspaceId: "p1", sessionIds: ["a", "b"] },
    { workspaceId: "p2", sessionIds: ["c"] },
    { workspaceId: "other", sessionIds: ["d"] },
  ];
  const projects = [{ id: "p1" }, { id: "p2" }];

  it.each([
    ["a", "p1"],
    ["c", "p2"],
    ["d", null],
    ["zzz", null],
    [undefined, null],
  ])("places %s in %s", (session, expected) => {
    expect(projectOfSession(projects, workspaces, session)).toBe(expected);
  });

  it("is null while the project list is unread", () => {
    expect(projectOfSession(null, workspaces, "a")).toBeNull();
  });
});

describe("followMainSession", () => {
  const cases: [string, Parameters<typeof followMainSession>[0], string | null][] = [
    [
      "first call keeps an open project",
      { previous: undefined, sessionProject: "b", open: "a" },
      "a",
    ],
    [
      "first call adopts the session's project",
      { previous: undefined, sessionProject: "b", open: null },
      "b",
    ],
    ["first call with nothing", { previous: undefined, sessionProject: null, open: null }, null],
    ["session outside any project", { previous: "a", sessionProject: null, open: "a" }, "a"],
    ["session did not move", { previous: "a", sessionProject: "a", open: "x" }, "x"],
    ["session moved to the open project", { previous: "a", sessionProject: "b", open: "b" }, "b"],
    ["user navigation in flight", { previous: "a", sessionProject: "b", open: "x" }, "x"],
    [
      "session moved while center was in sync",
      { previous: "a", sessionProject: "b", open: "a" },
      "b",
    ],
    [
      "session moved while on home, previous null",
      { previous: null, sessionProject: "b", open: null },
      "b",
    ],
    [
      "previous null, user opened something",
      { previous: null, sessionProject: "b", open: "x" },
      "x",
    ],
    [
      "session moved while on home, previous set",
      { previous: "a", sessionProject: "b", open: null },
      "b",
    ],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(followMainSession(input)).toBe(expected);
  });
});

describe("listedOrHome", () => {
  it("keeps a listed project", () => {
    expect(listedOrHome([{ id: "a" }], "a")).toBe("a");
  });
  it("sends an unlisted project home", () => {
    expect(listedOrHome([{ id: "a" }], "b")).toBeNull();
    expect(listedOrHome([], "b")).toBeNull();
  });
  it("leaves it alone while the list is unread or nothing is open", () => {
    expect(listedOrHome(null, "b")).toBe("b");
    expect(listedOrHome([{ id: "a" }], null)).toBeNull();
  });
});

describe("projectSessions", () => {
  const workspace: WorkspaceRow = { workspaceId: "p", sessionIds: ["a", "b", "c", "d", "gone"] };
  const sessions = { a: s("a", 1), b: s("b", 5), c: s("c", 5), d: s("d", 9), x: s("x", 99) };

  it("sorts newest first, keeping workspace order on ties", () => {
    expect(projectSessions(workspace, sessions, []).map((r) => r.id)).toEqual(["d", "b", "c", "a"]);
  });
  it("drops archived and unknown sessions", () => {
    expect(projectSessions(workspace, sessions, ["d"]).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
  it("is empty without a workspace", () => {
    expect(projectSessions(undefined, sessions, [])).toEqual([]);
  });
});

describe("pickSession", () => {
  const written = s("w", 5);
  const newer = s("n", 9);
  const blank = s("b", 7, true);
  const rows = [newer, blank, written];

  it("prefers the wanted session when listed", () => {
    expect(pickSession(rows, "w", "b")).toBe(blank);
  });
  it("ignores a wanted session that is not listed", () => {
    expect(pickSession(rows, "w", "nope")).toBe(written);
  });
  it("keeps the current session when it is written", () => {
    expect(pickSession(rows, "w")).toBe(written);
  });
  it("keeps a current session of the project even when it is blank", () => {
    // The chat the user just started must not be swapped for an older one on the way back.
    expect(pickSession(rows, "b")).toBe(blank);
  });
  it("takes the newest written row when the current session is elsewhere", () => {
    expect(pickSession(rows, "foreign")).toBe(newer);
    expect(pickSession(rows, undefined)).toBe(newer);
  });
  it("falls back to a blank current session", () => {
    expect(pickSession([blank], "b")).toBe(blank);
  });
  it("gives nothing when no row fits", () => {
    expect(pickSession([blank], "foreign")).toBeUndefined();
    expect(pickSession([], undefined)).toBeUndefined();
  });
});

describe("visibleSessions", () => {
  const rows = [s("a", 3), s("b", 2, true), s("c", 1, true)];
  it("hides blank rows except the current one, keeping order", () => {
    expect(visibleSessions(rows, "c").map((r) => r.id)).toEqual(["a", "c"]);
    expect(visibleSessions(rows, undefined).map((r) => r.id)).toEqual(["a"]);
  });
});
