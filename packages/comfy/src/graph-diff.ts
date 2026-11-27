import type { ApiGraph, ApiNode } from "./workflow.ts";

/**
 * One place where run snapshots disagree. `input` null = the node itself (present in some runs
 * only, or a different class); otherwise one input of the node. `values` has one slot per graph,
 * `undefined` where the node or input is absent.
 */
export interface GraphDiffRow {
  nodeId: string;
  /** The node's title (or class) from the first graph that has it. */
  label: string;
  input: string | null;
  values: unknown[]; // an entry is undefined where that graph has no such node or input
  /**
   * For node rows (`input: null`) between a first and a last graph: the node appears only in
   * the last (`added`), only in the first (`removed`), or changed class (`replaced`).
   */
  kind?: "added" | "removed" | "replaced";
}

function nodeLabel(node: ApiNode): string {
  return node._meta?.title || node.class_type;
}

/** Numeric node ids in number order, others after them alphabetically. */
export function compareNodeIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (Number.isFinite(na)) return -1;
  if (Number.isFinite(nb)) return 1;
  return a.localeCompare(b);
}

function same(values: unknown[]): boolean {
  const first = JSON.stringify(values[0]);
  return values.every((v) => JSON.stringify(v) === first);
}

/**
 * Differences between the API graphs of several runs (2–4 in the compare view), node by node and
 * input by input. `exclude` takes `nodeId.input` ids that are shown elsewhere (the exposed form
 * fields), so the rows here are only the changes the form does not show: a re-uploaded workflow,
 * an edited node, a re-wired link.
 */
export function diffGraphs(graphs: ApiGraph[], exclude: ReadonlySet<string> = new Set()) {
  const rows: GraphDiffRow[] = [];
  const nodeIds = [...new Set(graphs.flatMap((g) => Object.keys(g)))].toSorted(compareNodeIds);
  for (const nodeId of nodeIds) {
    const nodes = graphs.map((g) => g[nodeId]);
    const present = nodes.find((n) => n !== undefined)!;
    const label = nodeLabel(present);
    const classes = nodes.map((n) => n?.class_type);
    if (!same(classes)) {
      // A node missing from some runs, or replaced by another class: its inputs are not
      // comparable, so one row says so.
      const first = classes[0];
      const last = classes[classes.length - 1];
      const kind =
        first === undefined && last !== undefined
          ? "added"
          : first !== undefined && last === undefined
            ? "removed"
            : "replaced";
      rows.push({ nodeId, label, input: null, values: classes, kind });
      continue;
    }
    const inputs = [...new Set(nodes.flatMap((n) => Object.keys(n!.inputs)))].toSorted();
    for (const input of inputs) {
      if (exclude.has(`${nodeId}.${input}`)) continue;
      const values = nodes.map((n) => n!.inputs[input]);
      if (!same(values)) rows.push({ nodeId, label, input, values });
    }
  }
  return rows;
}

/** A link input (`[sourceNodeId, outputIndex]`) as the compare view shows it. */
export function isLinkValue(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
}
