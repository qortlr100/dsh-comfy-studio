/**
 * The `cs:project` system-prompt section: Project's general rules (the conversation's project, the history list, undo
 * and redo, stale records, and how to name records, assets, versions of the registered reference kinds
 * and other items). The text depends only on the registered reference kinds, which change only together with the
 * operation tool definitions, so it is the same at every step of a session; the project's state reaches the agent
 * through the project messages of the `project-updates` module. It holds nothing that the user cannot see in the views
 * or the conversation.
 *
 * Calls the `csProject` service's `listReferenceKinds`. Called by the service, which registers the section while the
 * DSH `systemPrompt` service is mounted.
 *
 * @module @cs/project/agent-context
 */
import type CsProject from "./index.ts";
import { kindListText } from "./agent-tools.ts";

/** The name of the system-prompt section. */
export const PROMPT_SECTION = "cs:project";

/** How the naming rule names a version: as one of the registered reference kinds; nothing while no kind is registered. */
const versionNaming = (kinds: readonly string[]): string =>
  kinds.length === 0 ? "" : `a ${kindListText(kinds)} version as <id>@<version>, `;

/**
 * The section text: the same for every session and every step while the registered reference kinds stay the same.
 * @param project - the service.
 * @returns the rules; the naming rule lists the registered reference kinds.
 */
export function projectContext(project: Pick<CsProject, "listReferenceKinds">): string {
  const kinds = project.listReferenceKinds();
  return [
    "DreamVerse project rules:",
    "- A conversation without a project starts the work with cs_proj_create. Once the DreamVerse project state message or " +
      "cs_proj_create names this conversation's project, do all work in it and never call cs_proj_create again. Changes of " +
      "the project that your own tool results did not show reach you as DreamVerse project updates; cs_proj_state reads the " +
      "whole project at any time.",
    "- Every call of yours and every edit of the user is a step of the project history at once; the user does not accept changes.",
    "- When the user asks to undo, roll back or go back to an earlier state, call cs_proj_undo: without to it goes back one " +
      "step; with to = a record ID from cs_proj_history_list the project shows its state just after that step. cs_proj_redo goes " +
      "forward one step. These moves add no step. A new change after a move discards the steps after the current one for good, " +
      "so when the user may still want them, ask before you change anything. Never rebuild an earlier state with new edits when " +
      "the user asked to go back.",
    "- Name things by the IDs in the project summary: a record by its record ID, an output of a record as <record>#<n>, " +
      `${versionNaming(kinds)}an asset by its asset ID, and any other item by the ID that the summary gives it. ` +
      "The user points at things with cs: mentions, which reach you as these IDs. " +
      "When the user's words fit more than one thing and no mention names it, ask which one instead of guessing.",
    "- Stale records had an input replaced. Render one again only when the user agrees; call cs_proj_stale_accept when the user keeps it as it is.",
  ].join("\n");
}
