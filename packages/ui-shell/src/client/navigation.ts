// Pure navigation rules of the shell: which project follows the main session, which chat
// session opening a project shows. No React and no dsh types, so tests need no fixtures.

export interface WorkspaceRow {
  readonly workspaceId: string;
  readonly sessionIds: readonly string[];
}

/** What the rules read of a session; a dsh `SessionSummary` fits and passes through as is. */
export interface SessionInfo {
  readonly id: string;
  readonly updatedAt: number;
  readonly blank: boolean;
}

/**
 * The project a session belongs to.
 * @param projects - the project list; null before it is read.
 * @param workspaces - dsh workspaces with their session ids (a project id is a workspace id).
 * @param sessionId - the session to place.
 * @returns the project id, or null when the session is unknown or sits in a non-project workspace.
 */
export function projectOfSession(
  projects: readonly { id: string }[] | null,
  workspaces: readonly WorkspaceRow[],
  sessionId: string | undefined,
): string | null {
  if (projects === null || sessionId === undefined) return null;
  for (const project of projects) {
    const workspace = workspaces.find((row) => row.workspaceId === project.id);
    if (workspace?.sessionIds.includes(sessionId)) return project.id;
  }
  return null;
}

/**
 * Decide the open project when the main session's project may have moved.
 * @param input.previous - the session's project as last seen; undefined on the first call.
 * @param input.sessionProject - the session's project now.
 * @param input.open - the project open in the center.
 * @returns the next open project.
 */
export function followMainSession(input: {
  previous: string | null | undefined;
  sessionProject: string | null;
  open: string | null;
}): string | null {
  const { previous, sessionProject, open } = input;
  if (previous === undefined) return open !== null ? open : sessionProject;
  if (sessionProject === null || sessionProject === previous || sessionProject === open) {
    return open;
  }
  // A navigation the user started is in flight; a late session move must not steal the center.
  if (open !== null && open !== previous) return open;
  return sessionProject;
}

/**
 * Decide whether the main session's first move into a project is dsh's startup restore of a
 * browser the shell has never seen, which must leave the center on the home page. Any
 * resolution to a project uses the arming up, whether or not it is swallowed.
 * @param input.armed - the browser is on its first visit and the user has not navigated yet.
 * @param input.sessionProject - the main session's project now.
 * @param input.open - the project open in the center.
 * @returns `swallow` to leave the center as it is, and the `armed` state for the next call.
 */
export function startupRestore(input: {
  armed: boolean;
  sessionProject: string | null;
  open: string | null;
}): { swallow: boolean; armed: boolean } {
  const { armed, sessionProject, open } = input;
  if (!armed || sessionProject === null) return { swallow: false, armed };
  return { swallow: open === null, armed: false };
}

/**
 * Send the center home when the open project left the list.
 * @param projects - the project list; null while unread.
 * @param open - the open project.
 * @returns `open`, or null when it is no longer listed.
 */
export function listedOrHome(
  projects: readonly { id: string }[] | null,
  open: string | null,
): string | null {
  if (projects === null || open === null) return open;
  return projects.some((project) => project.id === open) ? open : null;
}

/**
 * A project's chat sessions, newest first.
 * @param workspace - the project's workspace, if dsh has it.
 * @param sessions - session info by id.
 * @param archived - archived session ids, left out.
 * @returns the sessions; ties keep the workspace's order.
 */
export function projectSessions<S extends SessionInfo>(
  workspace: WorkspaceRow | undefined,
  sessions: Readonly<Record<string, S | undefined>>,
  archived: readonly string[],
): S[] {
  const rows: S[] = [];
  for (const id of workspace?.sessionIds ?? []) {
    const info = sessions[id];
    if (info !== undefined && !archived.includes(id)) rows.push(info);
  }
  return rows.toSorted((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Pick the session that opening a project shows.
 * @param rows - the project's sessions, newest first.
 * @param current - the current main session.
 * @param wanted - a session the caller asked for.
 * @returns the session, or undefined when the caller must open a blank one.
 */
export function pickSession<S extends SessionInfo>(
  rows: readonly S[],
  current: string | undefined,
  wanted?: string,
): S | undefined {
  const wantedRow = wanted === undefined ? undefined : rows.find((row) => row.id === wanted);
  if (wantedRow) return wantedRow;
  const currentRow = current === undefined ? undefined : rows.find((row) => row.id === current);
  // A main session that already sits in the project stays, blank or not: the user returns to
  // the chat they left (a blank one they just started would otherwise drop out of the list).
  if (currentRow) return currentRow;
  return rows.find((row) => !row.blank);
}

/**
 * Sessions to list: the written ones, plus the current one even when blank.
 * @param rows - the project's sessions.
 * @param current - the current main session.
 * @returns the rows to show, order preserved.
 */
export function visibleSessions<S extends SessionInfo>(
  rows: readonly S[],
  current: string | undefined,
): S[] {
  return rows.filter((row) => !row.blank || row.id === current);
}
