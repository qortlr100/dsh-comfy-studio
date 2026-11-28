// The narrow face of dsh that the shell's actions and subscriptions use. `hostOf` is the only
// place that reads dsh services for them, and the only place that turns a plain id into dsh's
// branded one (by finding it in a dsh snapshot, never by a cast). Tests hand-make a `ShellHost`.

import type { Context } from "@deepseek-ai/cordis";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import { AGENT_PRESET, CHAT_TAB_KIND } from "./ids.ts";
import type { SessionInfo, WorkspaceRow } from "./navigation.ts";
import { strings } from "./strings.ts";
import { claimFirstVisit, pageStorage } from "./visit.ts";

/** A value that changes; call the members as methods (dsh's stores need their `this`). */
export interface HostSource<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** Arrival lifecycle of a dsh list: `ready` once the first full list arrived. */
export type HostListPhase = "pending" | "ready";

/** What the shell reads of dsh's workspace list (`ctx.workspaces.list`). */
export interface HostWorkspaceList {
  readonly phase: HostListPhase;
  readonly items: readonly WorkspaceRow[];
  readonly archivedSessionIds: readonly string[];
}

/** What the shell reads of dsh's session list (`ctx.sessions.list`). */
export interface HostSessionList {
  readonly phase: HostListPhase;
  readonly byId: Readonly<Record<string, SessionInfo | undefined>>;
}

/** How `ShellHost.selectPreset` ended. */
export type PresetOutcome = "selected" | "declined";

/** The dsh services the shell's actions and subscriptions call, reduced to what they use. */
export interface ShellHost {
  readonly workspaces: HostSource<HostWorkspaceList>;
  readonly sessions: HostSource<HostSessionList>;
  /** The session whose right-panel seat is on screen (`sidebarRight.mounted`). */
  readonly mounted: HostSource<string | undefined>;
  /** Whether dsh lists this session (so `openSession` can open it). */
  knowsSession(sessionId: string): boolean;
  /** Make a listed session the main session. Throws `strings.unknownSession` for an unlisted one. */
  openSession(sessionId: string): void;
  /**
   * Make the workspace's blank session (reused or created by dsh) the main session. The call
   * names our agent preset (`AGENT_PRESET`), so the session runs it whatever default the user
   * picked in dsh's settings. Rejects with `strings.workspaceNotReady` when the workspace is not
   * listed.
   */
  openWorkspace(workspaceId: string): Promise<void>;
  /**
   * The agent preset a session runs, as dsh's session list reports it. Undefined when the
   * session is unlisted or its row reports no preset yet. Never throws.
   */
  sessionPreset(sessionId: string): string | undefined;
  /**
   * Ask dsh to run a blank session of a workspace under a preset, keeping the session.
   * @returns `selected` when dsh reused the session under the preset; `declined` when dsh found
   *   it no longer reusable (its conversation had started) and left it as it was. dsh then
   *   made another blank session in the workspace, which stays unopened.
   * Rejects with `strings.workspaceNotReady` or `strings.unknownSession` for an unlisted one,
   * and with dsh's error when dsh refuses the request.
   */
  selectPreset(workspaceId: string, sessionId: string, preset: string): Promise<PresetOutcome>;
  /** Cancel dsh's pending navigation, such as the startup restore of the saved session. */
  beginNavigation(): void;
  /**
   * Leave a dsh page (Plugins and the like) for the conversation column. This also cancels
   * dsh's pending navigation: `layout.selectPanel` aborts it, and an `openWorkspace` still in
   * flight then ends without moving the main session (upstream ui-layout `service.ts`,
   * ui-workspace `navigation.ts`). Every shell navigation starts with this call, which is how
   * going home stops a project that was still opening from taking the center back.
   */
  leavePage(): void;
  /** Open the chat tab in the mounted seat, expanding the panel. Throws while no seat is bound. */
  openChatTab(): void;
  /** Collapse the right panel when it is expanded. Never throws. */
  collapseRightPanel(): void;
  /**
   * Whether this is the browser's first visit, by the shell's own marker (never dsh's saved
   * state). It marks the browser as visited, so call it once per page load. Never throws.
   */
  claimFirstVisit(): boolean;
}

/**
 * The shell's host over the client services. Every dsh call here is a declared member of a
 * public client service; the devices that lean on dsh internals live in chrome.ts.
 * @param ctx - the client context with `workspaces`, `sessions`, `uiWorkspace`, `layout`, `sidebarRight`.
 * @returns the host; it reads the services on every call, so it stays current.
 */
export function hostOf(ctx: Context): ShellHost {
  const workspaces = ctx.workspaces.list;
  const sessions = ctx.sessions.list;

  const typedSession = (sessionId: string): SessionListState["ids"][number] | undefined => {
    const listed = sessions.getSnapshot().ids.find((id) => id === sessionId);
    if (listed !== undefined) return listed;
    for (const item of workspaces.getSnapshot().items) {
      const member = item.sessionIds.find((id) => id === sessionId);
      if (member !== undefined) return member;
    }
    return undefined;
  };

  return {
    workspaces,
    sessions,
    mounted: ctx.sidebarRight.mounted,
    knowsSession: (sessionId) => typedSession(sessionId) !== undefined,
    openSession(sessionId) {
      const typed = typedSession(sessionId);
      if (typed === undefined) throw new Error(strings.unknownSession);
      ctx.uiWorkspace.openSession(typed);
    },
    async openWorkspace(workspaceId) {
      const typed = workspaces
        .getSnapshot()
        .items.find((item) => item.workspaceId === workspaceId)?.workspaceId;
      if (typed === undefined) throw new Error(strings.workspaceNotReady);
      // dsh reuses a blank that lists no preset or this one, or creates one under this preset
      // (upstream packages/client/ui-workspace/src/client/navigation.ts `createInWorkspace`).
      // dsh's own entry points name no preset and follow the registry default instead; the
      // shell's `followAgentPreset` (follow.ts) puts a blank project chat back on ours.
      await ctx.uiWorkspace.openWorkspace(typed, undefined, { agentPreset: AGENT_PRESET });
    },
    sessionPreset(sessionId) {
      const typed = typedSession(sessionId);
      const values = typed === undefined ? undefined : sessions.getSnapshot().byId[typed];
      const projected = values?.projectionValues;
      // `agentPreset` is the preset registry's session projection, carried on every list row
      // (declared in @deepseek-ai/dsh-agent-preset-registry/types; dsh's ui-workspace and
      // ui-agent-preset read it the same way). That package is not one of our type packages,
      // so the key is read by a guard instead of its declaration.
      const value: unknown =
        projected === undefined ? undefined : Reflect.get(projected, "agentPreset");
      return typeof value === "string" ? value : undefined;
    },
    async selectPreset(workspaceId, sessionId, preset) {
      const workspace = workspaces
        .getSnapshot()
        .items.find((item) => item.workspaceId === workspaceId)?.workspaceId;
      if (workspace === undefined) throw new Error(strings.workspaceNotReady);
      const typed = typedSession(sessionId);
      if (typed === undefined) throw new Error(strings.unknownSession);
      // The documented reuse of `sessions.create`: the host reuses the named blank session while
      // it is reusable and runs it under the named preset, logging the change; a session that
      // has started a turn stays unchanged and the host makes another one instead (upstream
      // packages/api/session-controller/src/client/contract/sessions.ts `create`, host side
      // src/agent.ts `reuseLive`). dsh's own navigation names blanks this way.
      const created = await ctx.sessions.create({
        workspaceId: workspace,
        sessionId: typed,
        agentPreset: preset,
      });
      if (created === typed) return "selected";
      // As dsh does for a declined blank: its row may still read blank from cached metadata
      // (upstream ui-workspace navigation.ts `createNamed`).
      ctx.sessions.refreshProjections(typed).catch((error: unknown) => {
        console.warn("cs-shell: session projection reload failed", error);
      });
      return "declined";
    },
    beginNavigation() {
      ctx.layout.beginNavigation();
    },
    leavePage() {
      ctx.layout.selectPanel(null);
    },
    openChatTab() {
      ctx.sidebarRight.openTab(CHAT_TAB_KIND);
    },
    claimFirstVisit: () => claimFirstVisit(pageStorage()),
    collapseRightPanel() {
      try {
        if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
      } catch (error) {
        // A seat that unmounted between the two calls has nothing left to collapse.
        console.warn("cs-shell: right panel collapse failed", error);
      }
    },
  };
}
