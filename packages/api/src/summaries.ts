/**
 * Project card summaries for the shell's project list: per project, the cover and the last edit time, computed from
 * each project's current state so the browser reads one small list instead of every project's whole state.
 *
 * @module @cs/api/summaries
 */
import type { AssetId, ComponentStates, ProjectId } from "@cs/project";

/** The image a project card shows as its cover, with its MIME type. */
export interface WireProjectCover {
  asset: AssetId;
  mime: string;
}

/**
 * What a project card shows besides the title (`GET /api/cs/projects/summary`). In the list of every project, a project
 * whose state cannot be read gets `cover` null and `edited_at` null.
 */
export interface WireProjectSummary {
  project: ProjectId;
  /** The first image output of a finished record of the current state; null when the project has none. */
  cover: WireProjectCover | null;
  /** When the last record of the current state was written (its `finished_at`, else `created_at`), ISO-8601. */
  edited_at: string | null;
}

/** The slice of the project's current state that a summary reads: the records. */
export interface SummarySource {
  components: Pick<ComponentStates, "proj">;
}

/**
 * Summarize a project from its current state.
 * @param projectId - the project.
 * @param state - the project's current state.
 * @param mimeOf - the MIME type of an asset, or null for an asset the store does not hold.
 * @returns the cover and the last edit time.
 */
export function summarizeProject(
  projectId: ProjectId,
  state: SummarySource,
  mimeOf: (id: AssetId) => string | null,
): WireProjectSummary {
  const records = state.components.proj.records;
  let cover: WireProjectCover | null = null;
  for (const record of records) {
    if (record.status !== "done") continue;
    for (const asset of record.outputs) {
      const mime = mimeOf(asset);
      if (mime?.startsWith("image/") === true) {
        cover = { asset, mime };
        break;
      }
    }
    if (cover !== null) break;
  }
  const last = records.at(-1);
  const editedAt = last === undefined ? null : (last.finished_at ?? last.created_at);
  return { project: projectId, cover, edited_at: editedAt };
}
