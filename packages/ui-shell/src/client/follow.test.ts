import type { WireProject } from "@cs/api/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_TAB_ATTEMPTS,
  CHAT_TAB_RETRY_MS,
  followShellWith,
  PRESET_ATTEMPTS,
  PRESET_RETRY_MS,
  PROJECT_READ_RETRY_MS,
} from "./follow.ts";
import type {
  HostSessionList,
  HostSource,
  HostWorkspaceList,
  PresetOutcome,
  ShellHost,
} from "./host.ts";
import { AGENT_PRESET } from "./ids.ts";
import type { SessionInfo, WorkspaceRow } from "./navigation.ts";
import { createShellStore } from "./store.ts";

interface FakeSource<T> extends HostSource<T> {
  set(next: T): void;
}

function source<T>(initial: T): FakeSource<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      value = next;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

function isWire(value: unknown): value is WireProject {
  return typeof value === "object" && value !== null && "id" in value;
}

function project(id: string): WireProject {
  const value: unknown = {
    id,
    title: id,
    created_at: "2026-11-28T00:00:00.000Z",
    path: `/p/${id}`,
  };
  if (!isWire(value)) throw new Error("unreachable");
  return value;
}

/** Projects A (session s1) and B (session s2), and W, a dsh workspace that is no project. */
const ROWS: WorkspaceRow[] = [
  { workspaceId: "A", sessionIds: ["s1"] },
  { workspaceId: "B", sessionIds: ["s2"] },
  { workspaceId: "W", sessionIds: ["w1"] },
];

function unused(): never {
  throw new Error("not used by the subscriptions");
}

/** A project-list read that does nothing, for tests about the other subscriptions. */
function noRead(): Promise<void> {
  return Promise.resolve();
}

/** A store whose main session is `sessionId` and whose open project is A. */
function openOn(sessionId: string) {
  return createShellStore({ projects: [project("A"), project("B")], sessionId, projectId: "A" });
}

function fakeHost(ready = true, firstVisit = false) {
  const workspaces = source<HostWorkspaceList>({
    phase: ready ? "ready" : "pending",
    items: ROWS,
    archivedSessionIds: [],
  });
  const sessions = source<HostSessionList>({ phase: "ready", byId: {} });
  const mounted = source<string | undefined>(undefined);
  const chatTab = vi.fn<() => void>();
  const collapse = vi.fn<() => void>();
  const claimed = vi.fn<() => void>();
  const host: ShellHost = {
    workspaces,
    sessions,
    mounted,
    knowsSession: unused,
    openSession: unused,
    openWorkspace: unused,
    sessionPreset: () => undefined,
    selectPreset: unused,
    beginNavigation: unused,
    leavePage: unused,
    openChatTab: () => {
      chatTab();
    },
    collapseRightPanel: () => {
      collapse();
    },
    claimFirstVisit: () => {
      claimed();
      return firstVisit;
    },
  };
  return { host, workspaces, mounted, chatTab, collapse, claimed };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("project list", () => {
  it("is read at start and on every workspace change", () => {
    const { host, workspaces } = fakeHost();
    const read = vi.fn(() => Promise.resolve());
    const stop = followShellWith(host, createShellStore(), read);
    expect(read).toHaveBeenCalledTimes(1);
    workspaces.set({ ...workspaces.getSnapshot() });
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    workspaces.set({ ...workspaces.getSnapshot() });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retries a failed read after a pause, with one retry pending at most", async () => {
    vi.useFakeTimers();
    const { host, workspaces } = fakeHost();
    const read = vi.fn(() => Promise.reject(new Error("offline")));
    const stop = followShellWith(host, createShellStore(), read);
    workspaces.set({ ...workspaces.getSnapshot() });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PROJECT_READ_RETRY_MS - 1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(PROJECT_READ_RETRY_MS * 3);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once a read succeeds", async () => {
    vi.useFakeTimers();
    const { host } = fakeHost();
    const read = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const stop = followShellWith(host, createShellStore(), read);
    await vi.advanceTimersByTimeAsync(PROJECT_READ_RETRY_MS * 5);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("open project follows the main session", () => {
  it("opens the main session's project on the first call", () => {
    const { host } = fakeHost();
    const store = createShellStore({ projects: [project("A"), project("B")], sessionId: "s1" });
    const stop = followShellWith(host, store, noRead);
    expect(store.getSnapshot().projectId).toBe("A");
    stop();
  });

  it("keeps a project the user opened on the first call", () => {
    const { host } = fakeHost();
    const store = createShellStore({
      projects: [project("A"), project("B")],
      sessionId: "s1",
      projectId: "B",
    });
    const stop = followShellWith(host, store, noRead);
    expect(store.getSnapshot().projectId).toBe("B");
    stop();
  });

  it("waits for the project list and the workspace list", () => {
    const { host, workspaces } = fakeHost(false);
    const store = createShellStore({ sessionId: "s1" });
    const stop = followShellWith(host, store, noRead);
    store.set({ projects: [project("A"), project("B")] });
    expect(store.getSnapshot().projectId).toBeNull();
    workspaces.set({ ...workspaces.getSnapshot(), phase: "ready" });
    expect(store.getSnapshot().projectId).toBe("A");
    stop();
  });

  it("follows the session into another project and stays home after going home", () => {
    const { host } = fakeHost();
    const store = createShellStore({ projects: [project("A"), project("B")], sessionId: "s1" });
    const stop = followShellWith(host, store, noRead);
    store.set({ sessionId: "s2" });
    expect(store.getSnapshot().projectId).toBe("B");
    store.set({ projectId: null });
    expect(store.getSnapshot().projectId).toBeNull();
    store.set({ sessionId: "w1" });
    expect(store.getSnapshot().projectId).toBeNull();
    stop();
  });

  it("goes home when the open project leaves the list", () => {
    const { host } = fakeHost();
    const store = createShellStore({ projects: [project("A"), project("B")], sessionId: "s1" });
    const stop = followShellWith(host, store, noRead);
    expect(store.getSnapshot().projectId).toBe("A");
    store.set({ projects: [project("B")] });
    expect(store.getSnapshot().projectId).toBeNull();
    stop();
  });
});

/** The projects are listed and dsh has not picked a session yet. */
function freshStore() {
  return createShellStore({ projects: [project("A"), project("B")] });
}

describe("first visit", () => {
  it("claims the marker once at start, whatever the answer", () => {
    const { host, claimed } = fakeHost(true, false);
    const stop = followShellWith(host, freshStore(), noRead);
    expect(claimed).toHaveBeenCalledTimes(1);
    stop();
  });

  it("swallows dsh's startup restore: home stays, the panel folds, the session is recorded", () => {
    const { host, collapse } = fakeHost(true, true);
    const store = freshStore();
    const stop = followShellWith(host, store, noRead);
    store.set({ sessionId: "s2" });
    expect(store.getSnapshot().projectId).toBeNull();
    expect(store.getSnapshot().restoredSession).toBe("s2");
    expect(collapse).toHaveBeenCalledTimes(1);
    // Later sync passes over the same session change nothing.
    store.set({ sessionId: "s2" });
    expect(store.getSnapshot().projectId).toBeNull();
    expect(collapse).toHaveBeenCalledTimes(1);
    stop();
  });

  it("swallows the restore that is already there when the lists become ready", () => {
    const { host, workspaces, collapse } = fakeHost(false, true);
    const store = createShellStore({
      projects: [project("A"), project("B")],
      sessionId: "s1",
    });
    const stop = followShellWith(host, store, noRead);
    workspaces.set({ ...workspaces.getSnapshot(), phase: "ready" });
    expect(store.getSnapshot().projectId).toBeNull();
    expect(collapse).toHaveBeenCalledTimes(1);
    stop();
  });

  it("follows a later move of the main session after the swallow", () => {
    const { host } = fakeHost(true, true);
    const store = freshStore();
    const stop = followShellWith(host, store, noRead);
    store.set({ sessionId: "s1" });
    expect(store.getSnapshot().projectId).toBeNull();
    store.set({ sessionId: "s2" });
    expect(store.getSnapshot().projectId).toBe("B");
    stop();
  });

  it("does not swallow when the user navigated before the restore resolved", () => {
    const { host, collapse } = fakeHost(true, true);
    const store = freshStore();
    const stop = followShellWith(host, store, noRead);
    // What `begin` and `beginProject` do for a click on a project.
    store.set({ navigations: 1 });
    store.set({ projectId: "B" });
    store.set({ sessionId: "s1" });
    expect(store.getSnapshot().projectId).toBe("B");
    expect(collapse).not.toHaveBeenCalled();
    stop();
  });

  it("does not swallow a session the user opened by a navigation that opens no project", () => {
    const { host } = fakeHost(true, true);
    const store = freshStore();
    const stop = followShellWith(host, store, noRead);
    store.set({ navigations: 1 });
    store.set({ sessionId: "s2" });
    expect(store.getSnapshot().projectId).toBe("B");
    stop();
  });

  it("waits through a main session outside any project", () => {
    const { host } = fakeHost(true, true);
    const store = freshStore();
    const stop = followShellWith(host, store, noRead);
    store.set({ sessionId: "w1" });
    store.set({ sessionId: "s1" });
    expect(store.getSnapshot().projectId).toBeNull();
    expect(store.getSnapshot().restoredSession).toBe("s1");
    stop();
  });

  it("opens the restored project on a browser that has been here before", () => {
    const { host, collapse } = fakeHost(true, false);
    const store = freshStore();
    const stop = followShellWith(host, store, noRead);
    store.set({ sessionId: "s2" });
    expect(store.getSnapshot().projectId).toBe("B");
    expect(store.getSnapshot().restoredSession).toBeUndefined();
    expect(collapse).not.toHaveBeenCalled();
    stop();
  });
});

describe("chat tab", () => {
  it("opens once per session when the main session's seat mounts in the open project", () => {
    const { host, mounted, chatTab } = fakeHost();
    const stop = followShellWith(host, openOn("s1"), noRead);
    expect(chatTab).not.toHaveBeenCalled();
    mounted.set("s1");
    expect(chatTab).toHaveBeenCalledTimes(1);
    mounted.set(undefined);
    mounted.set("s1");
    expect(chatTab).toHaveBeenCalledTimes(1);
    stop();
  });

  it("opens again for a session it already opened when the user asks for the chat", () => {
    const { host, mounted, chatTab } = fakeHost();
    const store = openOn("s1");
    const stop = followShellWith(host, store, noRead);
    mounted.set("s1");
    expect(chatTab).toHaveBeenCalledTimes(1);
    // Home folded the panel; coming back to the project asks for the chat.
    store.set({ chatRequest: 1 });
    expect(chatTab).toHaveBeenCalledTimes(2);
    // One request, one open: a remount does not open it a third time.
    mounted.set(undefined);
    mounted.set("s1");
    expect(chatTab).toHaveBeenCalledTimes(2);
    stop();
  });

  it("opens once for every request", () => {
    const { host, mounted, chatTab } = fakeHost();
    const store = openOn("s1");
    const stop = followShellWith(host, store, noRead);
    mounted.set("s1");
    store.set({ chatRequest: 1 });
    store.set({ chatRequest: 2 });
    expect(chatTab).toHaveBeenCalledTimes(3);
    stop();
  });

  it("waits until the center reports the mounted session as the main session", () => {
    const { host, mounted, chatTab } = fakeHost();
    const store = createShellStore({ projects: [project("A")], projectId: "A" });
    const stop = followShellWith(host, store, noRead);
    mounted.set("s1");
    expect(chatTab).not.toHaveBeenCalled();
    store.set({ sessionId: "s1" });
    expect(chatTab).toHaveBeenCalledTimes(1);
    stop();
  });

  it("never opens for a session outside the open project", () => {
    const { host, mounted, chatTab } = fakeHost();
    const store = createShellStore({ projects: [project("A")], sessionId: "w1", projectId: null });
    const stop = followShellWith(host, store, noRead);
    mounted.set("w1");
    store.set({ projectId: "A" });
    expect(chatTab).not.toHaveBeenCalled();
    stop();
  });

  it("retries a throwing open on the timer and when the seat publishes again", async () => {
    vi.useFakeTimers();
    const { host, mounted, chatTab } = fakeHost();
    chatTab
      .mockImplementationOnce(() => {
        throw new Error("no seat");
      })
      .mockImplementationOnce(() => {
        throw new Error("no seat");
      });
    const stop = followShellWith(host, openOn("s1"), noRead);
    mounted.set("s1");
    expect(chatTab).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHAT_TAB_RETRY_MS);
    expect(chatTab).toHaveBeenCalledTimes(2);
    mounted.set("s1");
    expect(chatTab).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(CHAT_TAB_RETRY_MS * 10);
    mounted.set(undefined);
    mounted.set("s1");
    expect(chatTab).toHaveBeenCalledTimes(3);
    stop();
  });

  it("gives up after a bounded number of tries and warns once", async () => {
    vi.useFakeTimers();
    const { host, mounted, chatTab } = fakeHost();
    chatTab.mockImplementation(() => {
      throw new Error("no seat");
    });
    const stop = followShellWith(host, openOn("s1"), noRead);
    mounted.set("s1");
    await vi.advanceTimersByTimeAsync(CHAT_TAB_RETRY_MS * (CHAT_TAB_ATTEMPTS + 10));
    expect(chatTab).toHaveBeenCalledTimes(CHAT_TAB_ATTEMPTS);
    expect(console.warn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops retrying when the seat moves to another session or the plugin goes down", async () => {
    vi.useFakeTimers();
    const { host, mounted, chatTab } = fakeHost();
    chatTab.mockImplementation(() => {
      throw new Error("no seat");
    });
    const store = openOn("s1");
    const stop = followShellWith(host, store, noRead);
    mounted.set("s1");
    store.set({ projectId: null });
    await vi.advanceTimersByTimeAsync(CHAT_TAB_RETRY_MS * 5);
    expect(chatTab).toHaveBeenCalledTimes(1);
    store.set({ projectId: "A" });
    expect(chatTab).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(CHAT_TAB_RETRY_MS * 5);
    expect(chatTab).toHaveBeenCalledTimes(2);
  });
});

function info(row: { id: string; blank: boolean }): SessionInfo {
  return { id: row.id, updatedAt: 1, blank: row.blank };
}

/**
 * A host for the agent-preset rule: sessions s1 (project A), s2 (project B) and w1 (no project),
 * each with a listed preset, and `selectPreset` answered by the test.
 */
function presetHost(rows: { id: string; blank: boolean; preset: string | undefined }[]) {
  const { host, workspaces } = fakeHost();
  const presets = new Map(rows.map((row) => [row.id, row.preset]));
  const sessions = source<HostSessionList>({
    phase: "ready",
    byId: Object.fromEntries(rows.map((row) => [row.id, info(row)])),
  });
  const answers: { resolve(outcome: PresetOutcome): void; reject(error: unknown): void }[] = [];
  const select = vi.fn<(workspaceId: string, sessionId: string, preset: string) => void>();
  const presetFace: ShellHost = {
    ...host,
    sessions,
    sessionPreset: (id) => presets.get(id),
    selectPreset(workspaceId, sessionId, preset) {
      select(workspaceId, sessionId, preset);
      return new Promise<PresetOutcome>((resolve, reject) => {
        answers.push({ resolve, reject });
      });
    },
  };
  /** dsh's list reports a session's preset, or its blank flag, anew. */
  const list = (id: string, patch: { preset?: string; blank?: boolean }): void => {
    if ("preset" in patch) presets.set(id, patch.preset);
    const current = sessions.getSnapshot();
    const row = current.byId[id];
    const blank = patch.blank ?? row?.blank ?? true;
    sessions.set({ ...current, byId: { ...current.byId, [id]: info({ id, blank }) } });
  };
  /** Answers the oldest open request. */
  const answer = async (outcome: PresetOutcome | Error): Promise<void> => {
    const next = answers.shift();
    if (next === undefined) throw new Error("No request is open.");
    if (outcome instanceof Error) next.reject(outcome);
    else next.resolve(outcome);
    await settle();
  };
  return { host: presetFace, workspaces, select, list, answer };
}

describe("agent preset", () => {
  it("puts a project's blank chat on another preset back on ours, once at a time", async () => {
    const { host, select, list, answer } = presetHost([
      { id: "s1", blank: true, preset: "standard" },
    ]);
    const stop = followShellWith(host, openOn("s1"), noRead);
    expect(select.mock.calls).toEqual([["A", "s1", AGENT_PRESET]]);
    // dsh's list updates while the request is in flight start nothing.
    list("s1", { preset: "standard" });
    expect(select).toHaveBeenCalledTimes(1);
    await answer("selected");
    list("s1", { preset: AGENT_PRESET });
    list("s1", { preset: AGENT_PRESET });
    expect(select).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
    stop();
  });

  it.each([
    ["already on our preset", "s1", true, AGENT_PRESET],
    ["with a conversation", "s1", false, "standard"],
    ["outside every project", "w1", true, "standard"],
    ["reporting no preset", "s1", true, undefined],
  ])("leaves a main session %s alone", (_name, id, blank, preset) => {
    const { host, select } = presetHost([{ id, blank, preset }]);
    const stop = followShellWith(host, openOn(id), noRead);
    expect(select).not.toHaveBeenCalled();
    stop();
  });

  it("leaves the chat once its conversation starts", async () => {
    const { host, select, list, answer } = presetHost([
      { id: "s1", blank: true, preset: "standard" },
    ]);
    const stop = followShellWith(host, openOn("s1"), noRead);
    list("s1", { blank: false });
    await answer("selected");
    expect(select).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops for a session dsh declined, until the list reports our preset", async () => {
    vi.useFakeTimers();
    const { host, select, list, answer } = presetHost([
      { id: "s1", blank: true, preset: "standard" },
    ]);
    const stop = followShellWith(host, openOn("s1"), noRead);
    await answer("declined");
    list("s1", { preset: "standard" });
    await vi.advanceTimersByTimeAsync(PRESET_RETRY_MS * 5);
    expect(select).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
    stop();
  });

  it("waits for a late list update before asking again", async () => {
    vi.useFakeTimers();
    const { host, select, list, answer } = presetHost([
      { id: "s1", blank: true, preset: "standard" },
    ]);
    const stop = followShellWith(host, openOn("s1"), noRead);
    await answer("selected");
    list("s1", { preset: "standard" });
    expect(select).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PRESET_RETRY_MS - 1);
    list("s1", { preset: AGENT_PRESET });
    await vi.advanceTimersByTimeAsync(PRESET_RETRY_MS * 5);
    expect(select).toHaveBeenCalledTimes(1);
    stop();
  });

  it("puts a later switch back again", async () => {
    const { host, select, list, answer } = presetHost([
      { id: "s1", blank: true, preset: "standard" },
    ]);
    const stop = followShellWith(host, openOn("s1"), noRead);
    await answer("selected");
    list("s1", { preset: AGENT_PRESET });
    // Settings' "Set as new task default" on the blank on screen.
    list("s1", { preset: "standard" });
    expect(select).toHaveBeenCalledTimes(2);
    stop();
  });

  it("tries a bounded number of times after refusals and warns once", async () => {
    vi.useFakeTimers();
    const { host, select, list, answer } = presetHost([
      { id: "s1", blank: true, preset: "standard" },
    ]);
    const stop = followShellWith(host, openOn("s1"), noRead);
    for (let attempt = 1; attempt <= PRESET_ATTEMPTS; attempt += 1) {
      expect(select).toHaveBeenCalledTimes(attempt);
      await answer(new Error("refused"));
      await vi.advanceTimersByTimeAsync(PRESET_RETRY_MS);
    }
    list("s1", { preset: "standard" });
    await vi.advanceTimersByTimeAsync(PRESET_RETRY_MS * 5);
    expect(select).toHaveBeenCalledTimes(PRESET_ATTEMPTS);
    expect(console.warn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("follows the main session to another project's chat", async () => {
    const { host, select, answer } = presetHost([
      { id: "s1", blank: true, preset: AGENT_PRESET },
      { id: "s2", blank: true, preset: "standard" },
    ]);
    const store = openOn("s1");
    const stop = followShellWith(host, store, noRead);
    expect(select).not.toHaveBeenCalled();
    store.set({ sessionId: "s2", projectId: "B" });
    expect(select.mock.calls).toEqual([["B", "s2", AGENT_PRESET]]);
    await answer("selected");
    stop();
  });

  it("stops when the plugin goes down, a pending retry included", async () => {
    vi.useFakeTimers();
    const { host, select, list, answer } = presetHost([
      { id: "s1", blank: true, preset: "standard" },
    ]);
    const stop = followShellWith(host, openOn("s1"), noRead);
    await answer(new Error("refused"));
    stop();
    await vi.advanceTimersByTimeAsync(PRESET_RETRY_MS * 5);
    list("s1", { preset: "standard" });
    expect(select).toHaveBeenCalledTimes(1);
  });
});
