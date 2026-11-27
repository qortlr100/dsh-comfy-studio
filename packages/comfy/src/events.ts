import type { GenerationStatus } from "./types.ts";

/** Live progress of a queued/running generation. Held in server memory only. */
export interface GenerationProgress {
  /** Node currently executing, with its title when the graph has one. */
  node: string | null;
  nodeTitle: string | null;
  /** Nodes executed or served from cache so far, out of the graph's node count. */
  nodesDone: number;
  nodesTotal: number;
  /** Step progress inside the current node (sampler steps), when it reports any. */
  step: { value: number; max: number } | null;
}

/**
 * Events of one generation's progress stream, in order: `snapshot` first, then `status` and
 * `progress`, and `done` last. `View` is the caller's own picture of a generation; this library
 * does not define one.
 */
export type GenerationSseEvent<View> =
  | { type: "snapshot"; generation: View; progress: GenerationProgress | null }
  | { type: "status"; status: GenerationStatus }
  | { type: "progress"; progress: GenerationProgress }
  | { type: "done"; generation: View };

export function isTerminalStatus(status: GenerationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
