import { compareNodeIds, isLinkValue } from "./graph-diff.ts";
import type { ApiGraph } from "./workflow.ts";

/**
 * A graph as the model reads it: one line per node, inputs inline, links as `←node.output`.
 * Shorter than the JSON and the wiring is visible at a glance. Pure, shared by the
 * `get_workflow_graph` tool and the chat's workflow context prompt.
 *
 *   3 KSampler: model←4.0 positive←6.0 seed=1 steps=20 sampler_name="euler"
 *   6 CLIPTextEncode "Positive": clip←4.1 text="a cat"
 */

/** Longest literal string shown on a line before it is cut with `…`. */
export const MAX_LITERAL_CHARS = 80;

function literal(v: unknown): string {
  if (typeof v === "string") {
    const cut = v.length > MAX_LITERAL_CHARS ? `${v.slice(0, MAX_LITERAL_CHARS)}…` : v;
    return JSON.stringify(cut);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v) ?? "null";
}

/** One node's line. Links first, then literals, each in the graph's own input order. */
export function nodeLine(nodeId: string, node: ApiGraph[string]): string {
  const title = node._meta?.title;
  const head =
    title && title !== node.class_type
      ? `${nodeId} ${node.class_type} ${JSON.stringify(title)}`
      : `${nodeId} ${node.class_type}`;
  const links: string[] = [];
  const literals: string[] = [];
  for (const [input, value] of Object.entries(node.inputs)) {
    if (isLinkValue(value)) links.push(`${input}←${value[0]}.${value[1]}`);
    else literals.push(`${input}=${literal(value)}`);
  }
  const parts = [...links, ...literals];
  return parts.length > 0 ? `${head}: ${parts.join(" ")}` : head;
}

/**
 * The whole graph, or only `nodes` (unknown ids are skipped), one line per node in id order.
 * Callers that have a size limit check the result's length and fall back to `graphSummary`.
 */
export function graphToText(graph: ApiGraph, nodes?: readonly string[]): string {
  const wanted = nodes ? new Set(nodes) : null;
  return Object.keys(graph)
    .filter((id) => !wanted || wanted.has(id))
    .toSorted(compareNodeIds)
    .map((id) => nodeLine(id, graph[id]!))
    .join("\n");
}

/**
 * Node count and class counts, for a graph too large to list in one tool result. The output
 * ends with the node ids per class so the caller can ask for a slice with `nodes`.
 */
export function graphSummary(graph: ApiGraph): string {
  const byClass = new Map<string, string[]>();
  for (const id of Object.keys(graph).toSorted(compareNodeIds)) {
    const cls = graph[id]!.class_type;
    byClass.set(cls, [...(byClass.get(cls) ?? []), id]);
  }
  const lines = [...byClass.entries()]
    .toSorted((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([cls, ids]) => `${cls} ×${ids.length}: ${ids.join(", ")}`);
  return [`노드 ${Object.keys(graph).length}개`, ...lines].join("\n");
}

/** Node classes with how often each occurs, most frequent first (ties by name). */
export function nodeClassCounts(graph: ApiGraph): { classType: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const node of Object.values(graph))
    counts.set(node.class_type, (counts.get(node.class_type) ?? 0) + 1);
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([classType, count]) => ({ classType, count }));
}
