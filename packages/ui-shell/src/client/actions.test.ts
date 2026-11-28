import type { WireProject } from "@cs/api/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEAT_WAIT_MS, createShellActions, projectReader } from "./actions.ts";
import type { ShellClient } from "./contract.ts";
import type { HostSessionList, HostSource, HostWorkspaceList, ShellHost } from "./host.ts";
import type { SessionInfo, WorkspaceRow } from "./navigation.ts";
import { createShellStore } from "./store.ts";
import { strings } from "./strings.ts";

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

function project(id: string, title = id): WireProject {
  const value: unknown = { id, title, created_at: "2026-11-28T00:00:00.000Z", path: `/p/${id}` };
  if (!isWire(value)) throw new Error("unreachable");
  return value;
}

const written = (id: string, updatedAt: number): SessionInfo => ({ id, updatedAt, blank: false });

interface FakeOptions {
  /** Default true: an opened session gets its right-panel seat at once. */
  seats?: boolean;
  ready?: boolean;
  workspaces?: WorkspaceRow[];
  sessions?: SessionInfo[];
}

/** A hand-made dsh face that records what the actions call. */
function fakeHost(options: FakeOptions = {}) {
  const phase = options.ready === false ? "pending" : "ready";
  const calls: string[] = [];
  const workspaces = source<HostWorkspaceList>({
    phase,
    items: options.workspaces ?? [],
    archivedSessionIds: [],
  });
  const sessions = source<HostSessionList>({
    phase,
    byId: Object.fromEntries((options.sessions ?? []).map((info) => [info.id, info])),
  });
  const chatTab = vi.fn<() => void>();
  const mounted = source<string | undefined>(undefined);
  const seat = (id: string): void => {
    if (options.seats !== false) mounted.set(id);
  };
  const host: ShellHost = {
    workspaces,
    sessions,
    mounted,
    knowsSession: (id) => sessions.getSnapshot().byId[id] !== undefined,
    openSession: (id) => {
      calls.push(`openSession ${id}`);
      seat(id);
    },
    openWorkspace: (id) => {
      calls.push(`openWorkspace ${id}`);
      // dsh opens the workspace's blank session, creating it when there is none.
      const blank = `blank-${id}`;
      const list = workspaces.getSnapshot();
      workspaces.set({
        ...list,
        items: list.items.map((item) =>
          item.workspaceId === id && !item.sessionIds.includes(blank)
            ? { ...item, sessionIds: [...item.sessionIds, blank] }
            : item,
        ),
      });
      seat(blank);
      return Promise.resolve();
    },
    beginNavigation: () => {
      calls.push("beginNavigation");
    },
    leavePage: () => {
      calls.push("leavePage");
    },
    openChatTab: () => {
      calls.push("openChatTab");
      chatTab();
    },
    collapseRightPanel: () => {
      calls.push("collapseRightPanel");
    },
  };
  return { host, calls, workspaces, sessions, mounted, chatTab };
}

/** A view API fake over an in-memory project list. */
function fakeClient(initial: WireProject[]) {
  let list = initial;
  const client = {
    listProjects: vi.fn(() => Promise.resolve([...list])),
    createProject: vi.fn((title: string) => {
      const created = project("new", title);
      list = [...list, created];
      return Promise.resolve(created);
    }),
    renameProject: vi.fn((projectId: string, title: string) => {
      list = list.map((row) => (row.id === projectId ? project(row.id, title) : row));
      return Promise.resolve(title);
    }),
    removeProject: vi.fn((projectId: string) => {
      list = list.filter((row) => row.id !== projectId);
      return Promise.resolve();
    }),
  } satisfies ShellClient;
  return client;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Two projects: A with two written sessions, B with none. */
function setup(options: FakeOptions = {}) {
  const fake = fakeHost({
    workspaces: [
      { workspaceId: "A", sessionIds: ["s1", "s2"] },
      { workspaceId: "B", sessionIds: [] },
    ],
    sessions: [written("s1", 1), written("s2", 2)],
    ...options,
  });
  const projects = [project("A"), project("B")];
  const store = createShellStore({ projects });
  const client = fakeClient(projects);
  const actions = createShellActions(fake.host, store, client);
  return { ...fake, store, client, actions };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("openProject", () => {
  it("opens the project at once and moves the main session to its latest written session", async () => {
    const { actions, store, calls } = setup();
    actions.openProject("A");
    expect(store.getSnapshot().projectId).toBe("A");
    expect(calls).toEqual(["leavePage"]);
    await settle();
    expect(calls).toEqual(["leavePage", "beginNavigation", "openSession s2"]);
  });

  it("opens the session asked for", async () => {
    const { actions, calls } = setup();
    actions.openProject("A", "s1");
    await settle();
    expect(calls).toEqual(["leavePage", "beginNavigation", "openSession s1"]);
  });

  it("keeps a main session that already belongs to the project and asks for its chat", async () => {
    const { actions, store, calls, mounted } = setup();
    store.set({ sessionId: "s1" });
    mounted.set("s1");
    actions.openProject("A");
    await settle();
    // No session moves; the request makes the subscriptions open the tab `goHome` folded.
    expect(calls).toEqual(["leavePage"]);
    expect(store.getSnapshot().chatRequest).toBe(1);
  });

  it("asks for the chat only once the opened session has its seat", async () => {
    const { actions, store, calls, mounted } = setup({ seats: false });
    store.set({ sessionId: "s9" });
    mounted.set("s9");
    actions.openProject("A");
    await settle();
    expect(calls).toEqual(["leavePage", "beginNavigation", "openSession s2"]);
    // Asking now would open the tab of s9, the session being left.
    expect(store.getSnapshot().chatRequest).toBe(0);
    mounted.set("s2");
    await settle();
    expect(store.getSnapshot().chatRequest).toBe(1);
  });

  it("asks for the chat of the blank session dsh opened, once dsh lists it in the project", async () => {
    const { actions, store, calls } = setup();
    actions.openProject("B");
    await settle();
    expect(calls).toEqual(["leavePage", "openWorkspace B"]);
    expect(store.getSnapshot().chatRequest).toBe(1);
  });

  it("asks again on every return, so a panel folded by going home opens again", async () => {
    const { actions, store } = setup();
    actions.openProject("A");
    await settle();
    actions.goHome();
    actions.openProject("B");
    await settle();
    actions.goHome();
    actions.openProject("A");
    await settle();
    expect(store.getSnapshot().chatRequest).toBe(3);
  });

  it("returns the center to the main session's project when the open fails", async () => {
    const { actions, store, host } = setup();
    store.set({ sessionId: "s1", projectId: "A" });
    host.openWorkspace = () => Promise.reject(new Error("the host refused"));
    actions.openProject("B");
    expect(store.getSnapshot().projectId).toBe("B");
    await settle();
    // The main session is still s1 of A: the center must not show B beside A's chat.
    expect(store.getSnapshot().projectId).toBe("A");
    expect(store.getSnapshot().failure?.message).toBe(strings.actionFailed("the host refused"));
    expect(store.getSnapshot().chatRequest).toBe(0);
  });

  it("reports nothing while the session it keeps has no seat yet", async () => {
    vi.useFakeTimers();
    const { actions, store } = setup({ seats: false });
    store.set({ sessionId: "s1" });
    actions.openProject("A");
    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS + 1);
    expect(store.getSnapshot().failure).toBeNull();
    expect(store.getSnapshot().chatRequest).toBe(0);
  });

  it("opens the workspace when the project has no session", async () => {
    const { actions, calls } = setup();
    actions.openProject("B");
    await settle();
    expect(calls).toEqual(["leavePage", "openWorkspace B"]);
  });

  it("stops when a later navigation superseded it while the lists loaded", async () => {
    const { actions, store, calls, workspaces, sessions } = setup({ ready: false });
    actions.openProject("A");
    actions.goHome();
    workspaces.set({ ...workspaces.getSnapshot(), phase: "ready" });
    sessions.set({ ...sessions.getSnapshot(), phase: "ready" });
    await settle();
    expect(store.getSnapshot().projectId).toBeNull();
    expect(calls).toEqual(["leavePage", "leavePage", "collapseRightPanel"]);
  });

  it("chooses from the lists anyway when they do not arrive in time", async () => {
    vi.useFakeTimers();
    const { actions, calls } = setup({ ready: false });
    actions.openProject("B");
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toEqual(["leavePage"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["leavePage", "openWorkspace B"]);
  });

  it("waits for a workspace that reaches the list late", async () => {
    vi.useFakeTimers();
    const { actions, calls, workspaces } = setup();
    actions.openProject("C");
    await vi.advanceTimersByTimeAsync(1000);
    const list = workspaces.getSnapshot();
    workspaces.set({ ...list, items: [...list.items, { workspaceId: "C", sessionIds: [] }] });
    await settle();
    expect(calls).toEqual(["leavePage", "openWorkspace C"]);
  });

  it("reports a workspace that never appears", async () => {
    vi.useFakeTimers();
    const { actions, store, calls } = setup();
    actions.openProject("C");
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getSnapshot().failure).toEqual({
      seq: 1,
      message: strings.actionFailed(strings.workspaceNotReady),
    });
    expect(calls).toEqual(["leavePage"]);
  });
});

describe("newProject", () => {
  it("creates a project, lists it and opens a blank session in it", async () => {
    const { actions, store, client, calls, workspaces } = setup();
    const list = workspaces.getSnapshot();
    workspaces.set({ ...list, items: [...list.items, { workspaceId: "new", sessionIds: [] }] });
    actions.newProject();
    await settle();
    expect(client.createProject).toHaveBeenCalledWith(strings.newProjectTitle);
    expect(store.getSnapshot().projects?.map((row) => row.id)).toEqual(["A", "B", "new"]);
    expect(store.getSnapshot().projectId).toBe("new");
    expect(calls).toEqual(["leavePage", "openWorkspace new"]);
  });

  it("does not open the project when the user went elsewhere meanwhile", async () => {
    const { actions, store, calls } = setup();
    actions.newProject();
    actions.openProject("B");
    await settle();
    expect(store.getSnapshot().projectId).toBe("B");
    expect(calls).toEqual(["leavePage", "openWorkspace B"]);
  });
});

describe("newChat, openSession, goHome", () => {
  it("opens the workspace's blank session in the project", async () => {
    const { actions, store, calls } = setup();
    actions.newChat("A");
    expect(store.getSnapshot().projectId).toBe("A");
    await settle();
    expect(calls).toEqual(["leavePage", "openWorkspace A"]);
  });

  it("opens a listed session after cancelling dsh's pending navigation", async () => {
    const { actions, store, calls } = setup();
    actions.openSession("s1");
    await settle();
    expect(calls).toEqual(["leavePage", "beginNavigation", "openSession s1"]);
    expect(store.getSnapshot().failure).toBeNull();
  });

  it("reports a session dsh does not list", async () => {
    const { actions, store, calls } = setup();
    actions.openSession("nope");
    await settle();
    expect(calls).toEqual(["leavePage"]);
    expect(store.getSnapshot().failure?.message).toBe(strings.actionFailed(strings.unknownSession));
  });

  it("goes home and folds the right panel", () => {
    const { actions, store, calls } = setup();
    store.set({ projectId: "A" });
    actions.goHome();
    expect(store.getSnapshot().projectId).toBeNull();
    expect(calls).toEqual(["leavePage", "collapseRightPanel"]);
  });
});

describe("renameProject and removeProject", () => {
  it("does nothing for an empty or unchanged title", async () => {
    const { actions, client } = setup();
    actions.renameProject("A", "   ");
    actions.renameProject("A", " A ");
    await settle();
    expect(client.renameProject).not.toHaveBeenCalled();
  });

  it("renames with the trimmed title and reads the list again", async () => {
    const { actions, client, store } = setup();
    actions.renameProject("A", "  Next ");
    await settle();
    expect(client.renameProject).toHaveBeenCalledWith("A", "Next");
    expect(store.getSnapshot().projects?.[0]?.title).toBe("Next");
  });

  it("goes home after removing the open project", async () => {
    const { actions, store, calls } = setup();
    store.set({ projectId: "A" });
    actions.removeProject("A");
    await settle();
    expect(store.getSnapshot().projects?.map((row) => row.id)).toEqual(["B"]);
    expect(store.getSnapshot().projectId).toBeNull();
    expect(calls).toEqual(["leavePage", "collapseRightPanel"]);
  });

  it("stays on the open project after removing another", async () => {
    const { actions, store, calls } = setup();
    store.set({ projectId: "B" });
    actions.removeProject("A");
    await settle();
    expect(store.getSnapshot().projectId).toBe("B");
    expect(calls).toEqual([]);
  });
});

describe("failures", () => {
  it("shows each failure with a growing seq and dismisses only the shown one", async () => {
    const { actions, store, client } = setup();
    client.renameProject.mockRejectedValue(new Error("boom"));
    actions.renameProject("A", "X");
    await settle();
    expect(store.getSnapshot().failure).toEqual({ seq: 1, message: strings.actionFailed("boom") });
    actions.renameProject("A", "Y");
    await settle();
    expect(store.getSnapshot().failure?.seq).toBe(2);
    actions.dismissFailure(1);
    expect(store.getSnapshot().failure?.seq).toBe(2);
    actions.dismissFailure(2);
    expect(store.getSnapshot().failure).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("shows nothing when the chat tab cannot open for want of a seat", () => {
    const { actions, store, chatTab, calls } = setup();
    chatTab.mockImplementation(() => {
      throw new Error("sidebarRight: no session surface is mounted");
    });
    expect(() => {
      actions.showChat();
    }).not.toThrow();
    expect(calls).toEqual(["openChatTab"]);
    expect(store.getSnapshot().failure).toBeNull();
  });

  it("records the main session the center reports", () => {
    const { actions, store } = setup();
    actions.noteMainSession("s2");
    expect(store.getSnapshot().sessionId).toBe("s2");
  });
});

describe("newProject, pressed twice", () => {
  it("makes one project while the first creation is pending", async () => {
    const { actions, client } = setup();
    actions.newProject();
    actions.newProject();
    await settle();
    expect(client.createProject).toHaveBeenCalledTimes(1);
    actions.newProject();
    await settle();
    expect(client.createProject).toHaveBeenCalledTimes(2);
  });
});

describe("showChat", () => {
  it("opens the chat tab of the mounted seat", () => {
    const { actions, calls } = setup();
    actions.showChat();
    expect(calls).toEqual(["openChatTab"]);
  });

  it("enters the open project again when no seat is on screen", async () => {
    const { actions, store, calls, chatTab } = setup();
    store.set({ projectId: "B" });
    chatTab.mockImplementationOnce(() => {
      throw new Error("no session surface is mounted");
    });
    actions.showChat();
    await settle();
    expect(calls).toEqual(["openChatTab", "leavePage", "openWorkspace B"]);
    expect(store.getSnapshot().chatRequest).toBe(1);
    expect(store.getSnapshot().failure).toBeNull();
  });

  it("does nothing on the home page", async () => {
    const { actions, calls, chatTab } = setup();
    chatTab.mockImplementationOnce(() => {
      throw new Error("no session surface is mounted");
    });
    actions.showChat();
    await settle();
    expect(calls).toEqual(["openChatTab"]);
  });
});

describe("dispose", () => {
  it("ends a pending navigation at its next step and ignores later calls", async () => {
    const { actions, calls, workspaces, sessions } = setup({ ready: false });
    actions.openProject("A");
    actions.dispose();
    workspaces.set({ ...workspaces.getSnapshot(), phase: "ready" });
    sessions.set({ ...sessions.getSnapshot(), phase: "ready" });
    await settle();
    actions.openProject("B");
    actions.goHome();
    await settle();
    expect(calls).toEqual(["leavePage"]);
  });
});

describe("projectReader", () => {
  it("drops an older read that answers after a newer one", async () => {
    const store = createShellStore();
    const answers: ((projects: WireProject[]) => void)[] = [];
    const client: ShellClient = {
      listProjects: () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
      createProject: () => Promise.reject(new Error("unused")),
      renameProject: () => Promise.reject(new Error("unused")),
      removeProject: () => Promise.reject(new Error("unused")),
    };
    const read = projectReader(store, client);
    const first = read();
    const second = read();
    answers[1]?.([project("new")]);
    await second;
    answers[0]?.([project("old")]);
    await first;
    expect(store.getSnapshot().projects?.map((row) => row.id)).toEqual(["new"]);
  });
});
