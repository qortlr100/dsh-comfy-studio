import type { WireProject } from "@cs/api/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_TAB_ATTEMPTS,
  CHAT_TAB_RETRY_MS,
  followShellWith,
  PROJECT_READ_RETRY_MS,
} from "./follow.ts";
import type { HostSessionList, HostSource, HostWorkspaceList, ShellHost } from "./host.ts";
import type { WorkspaceRow } from "./navigation.ts";
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

function fakeHost(ready = true) {
  const workspaces = source<HostWorkspaceList>({
    phase: ready ? "ready" : "pending",
    items: ROWS,
    archivedSessionIds: [],
  });
  const sessions = source<HostSessionList>({ phase: "ready", byId: {} });
  const mounted = source<string | undefined>(undefined);
  const chatTab = vi.fn<() => void>();
  const host: ShellHost = {
    workspaces,
    sessions,
    mounted,
    knowsSession: unused,
    openSession: unused,
    openWorkspace: unused,
    beginNavigation: unused,
    leavePage: unused,
    openChatTab: () => {
      chatTab();
    },
    collapseRightPanel: unused,
  };
  return { host, workspaces, mounted, chatTab };
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
