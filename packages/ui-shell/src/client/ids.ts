// Identifiers the shell's modules and the integration test agree on. No strings a user reads.

/** The package the browser half is bundled from; dsh tags our style elements with it. */
export const OWNER = "@cs/ui-shell";

/** Implementation identity of the chat tab: the `key` of its body in `sidebar.right.pane.tab`. */
export const CHAT_TAB_ID = "@cs/ui-shell/chat";

/** The right-panel kind of the chat tab: what `sidebarRight.openTab` takes. */
export const CHAT_TAB_KIND = "cs-chat";

/** The list slot the center declares for the views of an open project. */
export const CENTER_VIEW_SLOT = "cs.center.view";

/** The `localStorage` key of the shell's own "this browser has been here" marker. */
export const VISITED_KEY = "cs.shell.visited";

/** The id of the failure toast in `shell.overlay`. */
export const FAILURE_TOAST_ID = "cs.shell.failure";

/**
 * The agent preset every session our screens create runs (`hostOf(ctx).openWorkspace`), so a
 * default the user picks in dsh's settings does not change them. It must equal the preset id of
 * the `preset-comfy-studio` row in packages/bundle/cordis.patch.yml.
 */
export const AGENT_PRESET = "comfy-studio";
