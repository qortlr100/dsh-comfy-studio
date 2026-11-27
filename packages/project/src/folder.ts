/**
 * The layout of a project folder, as pure code that host and client packages can share: no Node built-ins, no host
 * `Context`.
 *
 * @module @cs/project/folder
 */

/** The hidden directory of a project folder that holds every DreamVerse file; the user's own files stay beside it. */
export const PROJECT_DIR = ".comfy-studio";

/**
 * The Workspace a chat session runs in: the one whose path is the session's working directory. A session's working
 * directory never changes, so the answer changes only when a Workspace is registered or removed.
 * @param workspaces - the registered Workspaces, `workspaceRegistry.list()`.
 * @param cwd - the canonical (`realpath`) working directory from the session header; undefined when it has none.
 * @returns the Workspace, or undefined when no Workspace has that path.
 */
export function workspaceOfSession<W extends { readonly path: string }>(
  workspaces: readonly W[],
  cwd: string | undefined,
): W | undefined {
  return cwd === undefined ? undefined : workspaces.find((workspace) => workspace.path === cwd);
}
