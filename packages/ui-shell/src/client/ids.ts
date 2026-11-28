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
 * Our agent preset. It must equal the preset id of the `preset-comfy-studio` row in
 * packages/bundle/cordis.patch.yml. Sessions our screens create name it
 * (`hostOf(ctx).openWorkspace`), so they run it whatever default the user picks in dsh's
 * settings. dsh's own entry points (the sidebar brand by keyboard, the `session.new` shortcut,
 * the startup restore, Automation's "New task") name none and follow the registry default:
 * ours unless the user changed it. The shell puts a blank project chat that went to another
 * preset back on this one (`followAgentPreset` in follow.ts). A session that gets its first
 * message as it is created (a scheduled task's run in a new session, under the task's preset or
 * the default) or already has a conversation keeps the preset it has.
 */
export const AGENT_PRESET = "comfy-studio";
