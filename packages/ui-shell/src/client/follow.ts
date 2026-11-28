// The subscriptions `apply` starts for the plugin's lifetime: the project list follows dsh's
// workspace feed, the open project follows the dsh main session, the chat tab opens when a
// project session's right-panel seat mounts (docs/archive/PLAN_3-0.md "고른 것"), and a blank
// project chat goes back on our agent preset (stage 1-4).

import type { Context } from "@deepseek-ai/cordis";
import type { ProjectReader } from "./actions.ts";
import type { ShellStore } from "./contract.ts";
import { hostOf } from "./host.ts";
import type { ShellHost } from "./host.ts";
import { AGENT_PRESET } from "./ids.ts";
import {
  followMainSession,
  listedOrHome,
  presetToRestore,
  projectOfSession,
  startupRestore,
} from "./navigation.ts";

/** Milliseconds before a failed project list read is tried again. */
export const PROJECT_READ_RETRY_MS = 2000;

/** Milliseconds between tries to open the chat tab while the seat is not bound yet. */
export const CHAT_TAB_RETRY_MS = 250;

/** Tries to open the chat tab for one mounted session before giving up. */
export const CHAT_TAB_ATTEMPTS = 20;

/** Milliseconds before another try to put a blank project chat back on our agent preset. */
export const PRESET_RETRY_MS = 1000;

/** Tries per session to put it back on our agent preset before giving up with one warning. */
export const PRESET_ATTEMPTS = 3;

/**
 * Every project is a dsh workspace, so a project created, renamed or removed anywhere (another
 * browser tab, the agent) changes the workspace feed; each change reads the project list again.
 * A failed read is tried again after a pause, because no workspace change may follow it.
 */
function followProjectList(host: ShellHost, readProjects: ProjectReader): () => void {
  let retry: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const read = (): void => {
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    readProjects().catch((error: unknown) => {
      if (disposed) return;
      console.warn("cs-shell: project list read failed", error);
      retry ??= setTimeout(read, PROJECT_READ_RETRY_MS);
    });
  };
  read();
  const unsubscribe = host.workspaces.subscribe(read);
  return () => {
    disposed = true;
    unsubscribe();
    clearTimeout(retry);
  };
}

/**
 * The open project follows the main session when the session moves into another project (dsh's
 * restore after a reload, a session opened from dsh's own controls), by `followMainSession`.
 * On a browser's first visit, by the shell's own marker, dsh's startup restore of the most
 * recent project is swallowed once (`startupRestore`): the center stays home and the panel
 * folds. Any navigation the user starts through the shell (`ShellState.navigations`) ends that
 * first: a click during startup is never swallowed.
 */
function followOpenProject(host: ShellHost, store: ShellStore): () => void {
  let previous: string | null | undefined;
  let syncing = false;
  let armed = host.claimFirstVisit();
  let navigations = store.getSnapshot().navigations;
  const sync = (): void => {
    // Our own `set` below notifies this listener again.
    if (syncing) return;
    const workspaces = host.workspaces.getSnapshot();
    const snapshot = store.getSnapshot();
    const { projects, projectId, sessionId } = snapshot;
    if (snapshot.navigations !== navigations) {
      navigations = snapshot.navigations;
      armed = false;
    }
    if (workspaces.phase !== "ready" || projects === null) return;
    const sessionProject = projectOfSession(projects, workspaces.items, sessionId);
    const restore = startupRestore({ armed, sessionProject, open: projectId });
    armed = restore.armed;
    const before = previous;
    previous = sessionProject;
    syncing = true;
    try {
      if (restore.swallow) {
        store.set({ projectId: null, restoredSession: sessionId });
        host.collapseRightPanel();
      } else {
        const next = followMainSession({ previous: before, sessionProject, open: projectId });
        store.set({ projectId: listedOrHome(projects, next) });
      }
    } finally {
      syncing = false;
    }
  };
  const stopStore = store.subscribe(sync);
  const stopWorkspaces = host.workspaces.subscribe(sync);
  sync();
  return () => {
    stopStore();
    stopWorkspaces();
  };
}

/**
 * The chat tab opens for the main session of the open project when its seat is on screen: once
 * for a session's first mount in this page load (dsh's restore after a reload, a session dsh
 * opened by itself), and once for every chat request (`ShellState.chatRequest`: the user opened
 * a project or a chat from the navigator). A tab the user closed is not reopened by anything
 * else. `openTab` throws while no seat is bound (a remounting seat binds in a later effect), so
 * a failed open is tried again when the seat publishes again and on a timer, a bounded number
 * of times.
 */
function followChatTab(host: ShellHost, store: ShellStore): () => void {
  /** Sessions whose tab was opened in this page load. */
  const opened = new Set<string>();
  /** The chat request the last opened tab answered. */
  let served = store.getSnapshot().chatRequest;
  /** What the retries gave up on; a new request or another session starts over. */
  let gaveUp: { session: string; request: number } | undefined;
  let retry:
    | { session: string; attempts: number; timer: ReturnType<typeof setInterval>; failure: unknown }
    | undefined;

  /** The mounted session when the tab should open for it now. */
  const due = (): string | undefined => {
    const mounted = host.mounted.getSnapshot();
    if (mounted === undefined) return undefined;
    const { projects, projectId, sessionId, chatRequest } = store.getSnapshot();
    if (opened.has(mounted) && chatRequest === served) return undefined;
    if (gaveUp?.session === mounted && gaveUp.request === chatRequest) return undefined;
    if (mounted !== sessionId || projectId === null) return undefined;
    const owner = projectOfSession(projects, host.workspaces.getSnapshot().items, mounted);
    return owner === projectId ? mounted : undefined;
  };

  /** @returns the failure, or undefined when the tab opened. */
  const open = (session: string): unknown => {
    try {
      host.openChatTab();
      opened.add(session);
      served = store.getSnapshot().chatRequest;
      return undefined;
    } catch (error) {
      return error ?? new Error("openTab failed");
    }
  };

  const stopRetry = (): void => {
    if (retry === undefined) return;
    clearInterval(retry.timer);
    retry = undefined;
  };

  /** One more try for the session being retried. */
  const step = (): void => {
    if (retry === undefined) return;
    if (due() !== retry.session) {
      stopRetry();
      return;
    }
    retry.attempts += 1;
    const failure = open(retry.session);
    if (failure === undefined) {
      stopRetry();
      return;
    }
    retry.failure = failure;
    if (retry.attempts >= CHAT_TAB_ATTEMPTS) {
      console.warn("cs-shell: opening the chat tab failed", retry.failure);
      gaveUp = { session: retry.session, request: store.getSnapshot().chatRequest };
      stopRetry();
    }
  };

  const check = (): void => {
    const session = due();
    if (session === undefined || (retry !== undefined && retry.session !== session)) stopRetry();
    if (session === undefined || retry !== undefined) return;
    const failure = open(session);
    if (failure === undefined) return;
    retry = { session, attempts: 1, failure, timer: setInterval(step, CHAT_TAB_RETRY_MS) };
  };

  const onMounted = (): void => {
    if (host.mounted.getSnapshot() !== gaveUp?.session) gaveUp = undefined;
    if (retry !== undefined && host.mounted.getSnapshot() === retry.session) step();
    else check();
  };

  const stops = [
    host.mounted.subscribe(onMounted),
    store.subscribe(check),
    host.workspaces.subscribe(check),
  ];
  check();
  return () => {
    stopRetry();
    for (const stop of stops) stop();
  };
}

/**
 * A blank chat of a project goes back on our agent preset when it lists another one
 * (`presetToRestore`): dsh's own entry points reuse it under the user's default, which can be
 * `standard` with the shell and file tools. A chat whose conversation has started keeps its
 * preset; neither the shell nor dsh changes a composition once a turn ran.
 *
 * One request per session at a time, and none while one is in flight (dsh's list updates that
 * our own request causes land here too). A request that ends while the list still reports the
 * other preset is followed by another only after `PRESET_RETRY_MS`, so a list update that is
 * merely late settles it first; after `PRESET_ATTEMPTS` the shell stops trying for that session
 * with one warning. The list reporting our preset starts the count over, so a later switch
 * (settings' "Set as new task default" on the blank on screen) is put back again. When dsh
 * declines because the conversation started meanwhile, the shell leaves the session alone.
 * A request dsh makes for its own selection (settings, the preset chip) is ordered by the host
 * per session, so the last one to arrive wins and the list update after it decides again.
 */
function followAgentPreset(host: ShellHost, store: ShellStore): () => void {
  let disposed = false;
  let track:
    | {
        readonly session: string;
        attempts: number;
        busy: boolean;
        /** Declined by dsh or given up; only the list reporting our preset clears it. */
        settled: boolean;
        timer: ReturnType<typeof setTimeout> | undefined;
        failure: unknown;
      }
    | undefined;

  const stopTimer = (): void => {
    if (track?.timer === undefined) return;
    clearTimeout(track.timer);
    track.timer = undefined;
  };

  /** The main session's project when the rule asks to put the session back now. */
  const due = (): { project: string; session: string } | undefined => {
    const { projects, sessionId } = store.getSnapshot();
    if (sessionId === undefined) return undefined;
    const workspaces = host.workspaces.getSnapshot();
    if (workspaces.phase !== "ready") return undefined;
    const project = projectOfSession(projects, workspaces.items, sessionId);
    const restore = presetToRestore({
      project,
      session: host.sessions.getSnapshot().byId[sessionId],
      archived: workspaces.archivedSessionIds.includes(sessionId),
      listed: host.sessionPreset(sessionId),
      wanted: AGENT_PRESET,
    });
    return restore && project !== null ? { project, session: sessionId } : undefined;
  };

  const fire = (): void => {
    const entry = track;
    const target = due();
    if (disposed || entry === undefined || entry.busy || target?.session !== entry.session) return;
    entry.busy = true;
    entry.attempts += 1;
    void (async () => {
      try {
        const outcome = await host.selectPreset(target.project, target.session, AGENT_PRESET);
        if (outcome === "declined") entry.settled = true;
      } catch (error) {
        entry.failure = error ?? new Error("selectPreset failed");
      } finally {
        entry.busy = false;
        if (!disposed && track === entry) check();
      }
    })();
  };

  function check(): void {
    if (disposed) return;
    const main = store.getSnapshot().sessionId;
    if (track !== undefined && track.session !== main) {
      stopTimer();
      track = undefined;
    }
    if (main === undefined) return;
    track ??= {
      session: main,
      attempts: 0,
      busy: false,
      settled: false,
      timer: undefined,
      failure: undefined,
    };
    if (host.sessionPreset(main) === AGENT_PRESET) {
      stopTimer();
      track.attempts = 0;
      track.settled = false;
      track.failure = undefined;
      return;
    }
    if (due() === undefined) {
      stopTimer();
      return;
    }
    if (track.busy || track.settled || track.timer !== undefined) return;
    if (track.attempts >= PRESET_ATTEMPTS) {
      track.settled = true;
      console.warn("cs-shell: putting the chat back on the agent preset failed", track.failure);
      return;
    }
    if (track.attempts === 0) {
      fire();
      return;
    }
    const entry = track;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      fire();
    }, PRESET_RETRY_MS);
  }

  const stops = [
    store.subscribe(check),
    host.sessions.subscribe(check),
    host.workspaces.subscribe(check),
  ];
  check();
  return () => {
    disposed = true;
    stopTimer();
    for (const stop of stops) stop();
  };
}

/**
 * Start the shell's subscriptions over a dsh face. `followShell` is this with the real services.
 * @param host - the dsh face.
 * @param store - the shell store.
 * @param readProjects - the shared project-list read of the store.
 * @returns a function that ends every subscription and pending timer.
 */
export function followShellWith(
  host: ShellHost,
  store: ShellStore,
  readProjects: ProjectReader,
): () => void {
  const stops = [
    followProjectList(host, readProjects),
    followOpenProject(host, store),
    followChatTab(host, store),
    followAgentPreset(host, store),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

/**
 * Start the shell's subscriptions; they end when the plugin goes down.
 * @param ctx - the client context with the services `index.ts` injects.
 * @param store - the shell store.
 * @param readProjects - the store's project-list read, shared with `createActions`.
 */
export function followShell(ctx: Context, store: ShellStore, readProjects: ProjectReader): void {
  ctx.effect(() => followShellWith(hostOf(ctx), store, readProjects));
}
