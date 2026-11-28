// What the shell's React components may do, done through dsh's services. The shell's open
// project decides the center, and the dsh main session follows it: opening a project moves the
// main session to one of the project's chat sessions, or to the blank session of the project's
// workspace when it has none, so the right panel's chat always belongs to the project shown.
// Every action returns at once; a failure lands in `ShellState.failure` (docs/archive/PLAN_3-0.md).

import type { Context } from "@deepseek-ai/cordis";
import type { WireProject } from "@cs/api/wire";
import type { ShellActions, ShellClient, ShellStore } from "./contract.ts";
import { hostOf } from "./host.ts";
import type { HostSource, ShellHost } from "./host.ts";
import type { WorkspaceRow } from "./navigation.ts";
import { pickSession, projectOfSession, projectSessions } from "./navigation.ts";
import { strings } from "./strings.ts";

/** Milliseconds to wait for dsh's workspace and session lists before choosing from them anyway. */
export const LIST_READY_TIMEOUT_MS = 5000;

/** Milliseconds to wait for a project's workspace to reach dsh's workspace list. */
export const WORKSPACE_WAIT_MS = 5000;

/** Milliseconds to wait for the session a navigation opened to get its right-panel seat. */
export const SEAT_WAIT_MS = 5000;

/** The shell actions, and the switch that turns them off when the plugin goes down. */
export type DisposableShellActions = ShellActions & {
  /** Stop: pending navigations end at their next step and later calls do nothing. */
  dispose(this: void): void;
};

/** Reads the project list into the store; see {@link projectReader}. */
export type ProjectReader = () => Promise<void>;

/**
 * The project-list read of a store: `client.listProjects()` into `projects`. A read that answers
 * after a later-started read already answered is dropped, so an old list never replaces a newer
 * one. `apply` makes ONE reader and hands it to both the actions and the subscriptions: only a
 * shared counter keeps a feed read that started before `newProject`'s read from answering last
 * and taking the new project off the list (which would send the center home).
 * @param store - the shell store.
 * @param client - the view API client.
 * @returns a function that reads once; it rejects when the read fails.
 */
export function projectReader(store: ShellStore, client: ShellClient): ProjectReader {
  let started = 0;
  let applied = 0;
  const read: ProjectReader = async () => {
    started += 1;
    const mine = started;
    const projects = await client.listProjects();
    if (mine < applied) return;
    applied = mine;
    store.set({ projects });
  };
  return read;
}

/**
 * Wait until `probe` answers, re-asking whenever one of `sources` changes.
 * @param sources - what the answer depends on.
 * @param probe - the answer, or undefined while there is none.
 * @param timeoutMs - how long to wait.
 * @returns the answer, or undefined when the time ran out.
 */
function waitFor<T>(
  sources: readonly HostSource<unknown>[],
  probe: () => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const now = probe();
    if (now !== undefined) {
      resolve(now);
      return;
    }
    let settled = false;
    const stops: (() => void)[] = [];
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stop of stops) stop();
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(undefined);
    }, timeoutMs);
    const check = (): void => {
      const value = probe();
      if (value !== undefined) finish(value);
    };
    for (const source of sources) stops.push(source.subscribe(check));
  });
}

/**
 * Resolve once dsh's workspace and session lists have both arrived, or after the timeout.
 * @param host - the dsh face.
 * @returns completion; never rejects.
 */
export async function whenListsReady(host: ShellHost): Promise<void> {
  await waitFor(
    [host.workspaces, host.sessions],
    () =>
      host.workspaces.getSnapshot().phase === "ready" &&
      host.sessions.getSnapshot().phase === "ready"
        ? true
        : undefined,
    LIST_READY_TIMEOUT_MS,
  );
}

/**
 * The workspace row of a project. A project created a moment ago reaches the client's list
 * through dsh's workspace feed, so the row is waited for.
 * @param host - the dsh face.
 * @param projectId - the project, which is its workspace id.
 * @returns the row; rejects with `strings.workspaceNotReady` when it does not appear in time.
 */
async function projectWorkspace(host: ShellHost, projectId: string): Promise<WorkspaceRow> {
  const row = await waitFor(
    [host.workspaces],
    () => host.workspaces.getSnapshot().items.find((item) => item.workspaceId === projectId),
    WORKSPACE_WAIT_MS,
  );
  if (row === undefined) throw new Error(strings.workspaceNotReady);
  return row;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The shell actions over a dsh face. `createActions` is this with the real services.
 * @param host - the dsh face.
 * @param store - the shell store.
 * @param client - the view API client.
 * @param refreshProjects - the store's project-list read; pass the one the subscriptions use.
 * @returns the actions.
 */
export function createShellActions(
  host: ShellHost,
  store: ShellStore,
  client: ShellClient,
  refreshProjects: ProjectReader = projectReader(store, client),
): DisposableShellActions {
  let failures = 0;
  // Grows with every shell navigation; an async navigation stops when another one started.
  let navigation = 0;
  let creating = false;
  let disposed = false;

  /** Run an action; a rejection becomes the shown failure, also from a superseded navigation. */
  const run = (work: () => Promise<void> | void): void => {
    if (disposed) return;
    const invoke = async (): Promise<void> => {
      await work();
    };
    invoke().catch((error: unknown) => {
      if (disposed) return;
      console.warn("cs-shell: action failed", error);
      failures += 1;
      store.set({ failure: { seq: failures, message: strings.actionFailed(messageOf(error)) } });
    });
  };

  /**
   * Start a navigation; the returned check is false once a later one started. `leavePage`
   * also cancels what dsh still had pending for the navigation before (see `ShellHost`).
   */
  const begin = (): (() => boolean) => {
    host.leavePage();
    navigation += 1;
    const mine = navigation;
    return () => !disposed && navigation === mine;
  };

  /** Start a navigation to `projectId`, shown in the center at once. */
  const beginProject = (projectId: string | null): (() => boolean) => {
    const current = begin();
    store.set({ projectId });
    return () => current() && store.getSnapshot().projectId === projectId;
  };

  /** Ask for the chat tab of the main session; follow.ts opens it, retrying while the seat binds. */
  const requestChat = (): void => {
    store.set({ chatRequest: store.getSnapshot().chatRequest + 1 });
  };

  /**
   * Ask for the chat once the session the navigation opened has its seat on screen. Asking
   * earlier would open the tab of the session being left.
   * @param current - whether the navigation is still the latest.
   * @param arrived - whether the mounted session is the one the navigation opened.
   */
  const chatWhenSeated = async (
    current: () => boolean,
    arrived: (mounted: string) => boolean,
  ): Promise<void> => {
    const seated = await waitFor(
      [host.mounted, host.workspaces],
      () => {
        const mounted = host.mounted.getSnapshot();
        return mounted !== undefined && arrived(mounted) ? mounted : undefined;
      },
      SEAT_WAIT_MS,
    );
    if (seated !== undefined && current()) requestChat();
  };

  /** Whether dsh lists the session in the project's workspace (read fresh: dsh may just have made it). */
  const inProject = (projectId: string, sessionId: string): boolean =>
    host.workspaces
      .getSnapshot()
      .items.some((item) => item.workspaceId === projectId && item.sessionIds.includes(sessionId));

  /** The project the main session sits in, if any. */
  const mainProject = (): string | null => {
    const { projects, sessionId } = store.getSnapshot();
    return projectOfSession(projects, host.workspaces.getSnapshot().items, sessionId);
  };

  /** Move the main session into the project, on the session `pickSession` names. */
  const enterProject = async (
    projectId: string,
    current: () => boolean,
    sessionId?: string,
  ): Promise<void> => {
    await whenListsReady(host);
    if (!current()) return;
    const workspace = await projectWorkspace(host, projectId);
    if (!current()) return;
    const rows = projectSessions(
      workspace,
      host.sessions.getSnapshot().byId,
      host.workspaces.getSnapshot().archivedSessionIds,
    );
    const main = store.getSnapshot().sessionId;
    const pick = pickSession(rows, main, sessionId);
    if (pick === undefined) {
      // dsh reuses the workspace's blank session or creates one, and makes it the main session.
      await host.openWorkspace(projectId);
      await chatWhenSeated(current, (mounted) => inProject(projectId, mounted));
      return;
    }
    if (pick.id !== main) {
      // Cancels dsh's pending startup restore, which would otherwise replace this session.
      host.beginNavigation();
      host.openSession(pick.id);
    }
    await chatWhenSeated(current, (mounted) => mounted === pick.id);
  };

  const showProject = async (projectId: string, sessionId?: string): Promise<void> => {
    const current = beginProject(projectId);
    try {
      await enterProject(projectId, current, sessionId);
    } catch (error) {
      // The main session did not move. The center returns to the project that session belongs
      // to, so it never shows one project beside the chat of another.
      if (current()) store.set({ projectId: mainProject() });
      throw error;
    }
  };

  const showHome = (): void => {
    beginProject(null);
    host.collapseRightPanel();
  };

  return {
    newProject() {
      // A second press while the first project is being made would make a second one.
      if (creating) return;
      creating = true;
      run(async () => {
        const before = navigation;
        let created: WireProject;
        try {
          created = await client.createProject(strings.newProjectTitle);
          await refreshProjects();
        } finally {
          // Only the creation is guarded; opening the project may wait on dsh for seconds.
          creating = false;
        }
        // The user went elsewhere while the project was made; it stays listed, unopened.
        if (navigation !== before) return;
        await showProject(created.id);
      });
    },
    openProject(projectId, sessionId) {
      run(() => showProject(projectId, sessionId));
    },
    openSession(sessionId) {
      run(async () => {
        const current = begin();
        if (!host.knowsSession(sessionId)) throw new Error(strings.unknownSession);
        host.beginNavigation();
        host.openSession(sessionId);
        await chatWhenSeated(current, (mounted) => mounted === sessionId);
      });
    },
    newChat(projectId) {
      run(async () => {
        const current = beginProject(projectId);
        try {
          await projectWorkspace(host, projectId);
          if (!current()) return;
          await host.openWorkspace(projectId);
          await chatWhenSeated(current, (mounted) => inProject(projectId, mounted));
        } catch (error) {
          if (current()) store.set({ projectId: mainProject() });
          throw error;
        }
      });
    },
    goHome() {
      run(showHome);
    },
    renameProject(projectId, title) {
      const next = title.trim();
      const listed = store.getSnapshot().projects?.find((project) => project.id === projectId);
      if (next === "" || next === listed?.title) return;
      run(async () => {
        await client.renameProject(projectId, next);
        await refreshProjects();
      });
    },
    removeProject(projectId) {
      run(async () => {
        const wasOpen = store.getSnapshot().projectId === projectId;
        await client.removeProject(projectId);
        await refreshProjects();
        // The list read may already have sent the center home; the panel still has to fold.
        const open = store.getSnapshot().projectId;
        if (wasOpen && (open === projectId || open === null)) showHome();
      });
    },
    showChat() {
      try {
        host.openChatTab();
      } catch {
        // No seat is on screen: dsh has no main session (the last one was archived, say), or
        // the seat is binding. Entering the open project again brings a session and its chat.
        const open = store.getSnapshot().projectId;
        if (open !== null) run(() => showProject(open));
      }
    },
    noteMainSession(sessionId) {
      store.set({ sessionId });
    },
    dismissFailure(seq) {
      if (store.getSnapshot().failure?.seq === seq) store.set({ failure: null });
    },
    dispose() {
      disposed = true;
      navigation += 1;
    },
  };
}

/**
 * The shell actions over the client services.
 * @param ctx - the client context with the services `index.ts` injects.
 * @param store - the shell store.
 * @param client - the view API client.
 * @param readProjects - the store's project-list read, shared with `followShell`.
 * @returns the actions handed to every shell registration.
 */
export function createActions(
  ctx: Context,
  store: ShellStore,
  client: ShellClient,
  readProjects: ProjectReader,
): ShellActions {
  const actions = createShellActions(hostOf(ctx), store, client, readProjects);
  // A navigation still waiting when the plugin goes down must not call into dead services.
  ctx.effect(() => actions.dispose);
  return actions;
}
