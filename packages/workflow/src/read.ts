/**
 * The reports of the workflow read operations (`workflow.list`, `workflow.get`, `workflow.graph`,
 * `workflow.check_patch`), as pure functions of the slice or the graph. The report types are in `types.ts`; the
 * design is `docs/archive/PLAN_2-3c.md`.
 *
 * @module @cs/workflow/read
 */
import { compareNodeIds } from "@cs/comfy/graph-diff";
import { hasErrors } from "@cs/comfy/graph-patch";
import { graphSummary, graphToText, nodeLine } from "@cs/comfy/graph-text";
import type { ApiGraph, ObjectInfo } from "@cs/comfy/workflow";
import { ProjectError } from "@cs/project";
import type { RecordId } from "@cs/project/types";
import { applyPatch, ellipsize, parsePatch, problemLines } from "./files.ts";
import {
  WORKFLOW_LIMITS,
  type WorkflowGetReport,
  type WorkflowGraphReport,
  type WorkflowItem,
  type WorkflowListReport,
  type WorkflowPatchReport,
  type WorkflowSlice,
} from "./types.ts";

/**
 * @param a - a text.
 * @param b - a text.
 * @returns the order of the two by code units.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param slice - the workflows.
 * @param q - the words to look for, if any.
 * @returns the report: workflows newest-updated first, then by ID. With `q`, only those whose name or description
 *   contains every word (case-insensitive).
 */
export function listReport(slice: WorkflowSlice, q?: string): WorkflowListReport {
  const words = (q ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const matching = Object.values(slice.items).filter((item) => {
    const text = `${item.name}\n${item.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  matching.sort((a, b) => compareText(b.updated_at, a.updated_at) || compareText(a.id, b.id));
  return {
    workflows: matching.map((item) => ({
      id: item.id,
      name: item.name,
      description: ellipsize(item.description, WORKFLOW_LIMITS.summaryDescriptionChars),
      nodes: item.nodes,
      fields: item.fields.length,
      parent: item.parent,
      updated_at: item.updated_at,
    })),
  };
}

/**
 * @param slice - the workflows.
 * @param id - a workflow ID.
 * @returns the workflow with its parent and the variants made from it.
 * @throws ProjectError `invalid_params` for an unknown workflow.
 */
export function getReport(slice: WorkflowSlice, id: RecordId): WorkflowGetReport {
  const item = Object.hasOwn(slice.items, id) ? slice.items[id] : undefined;
  if (item === undefined) throw new ProjectError("invalid_params", `Unknown workflow '${id}'.`);
  const parent =
    item.parent === null || !Object.hasOwn(slice.items, item.parent)
      ? undefined
      : slice.items[item.parent];
  const variants: WorkflowItem[] = Object.values(slice.items)
    .filter((other) => other.parent === id)
    .toSorted((a, b) => compareText(a.created_at, b.created_at) || compareText(a.id, b.id));
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    nodes: item.nodes,
    fields: item.fields,
    target: item.target,
    parent: parent === undefined ? null : { id: parent.id, name: parent.name },
    variants: variants.map((variant) => ({ id: variant.id, name: variant.name })),
  };
}

/**
 * @param lines - the lines of a text.
 * @param what - what the lines are, for the note at the end ("nodes").
 * @returns the lines joined; when they are over `WORKFLOW_LIMITS.graphTextChars`, cut at a line boundary with a last
 *   line that says how many were left out.
 */
function cutLines(lines: string[], what: string, advice = "ask for fewer"): string {
  const limit = WORKFLOW_LIMITS.graphTextChars;
  const whole = lines.join("\n");
  if (whole.length <= limit) return whole;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > limit) break;
    kept.push(line);
    used += line.length + 1;
  }
  // A single line over the limit is cut inside the line rather than answering nothing; by code points, so a surrogate
  // pair is never split.
  if (kept.length === 0 && lines[0] !== undefined) {
    kept.push(Array.from(lines[0]).slice(0, limit).join(""));
  }
  const left = lines.length - kept.length;
  return [...kept, `… ${left} more ${what} left out; ${advice}.`].join("\n");
}

/**
 * @param id - the workflow.
 * @param graph - its graph.
 * @param nodes - the node IDs to read; absent for the whole graph.
 * @returns one line per node; a graph over `WORKFLOW_LIMITS.graphTextChars` read whole answers its outline by class
 *   instead, and a filtered read that is still too long is cut at a line boundary.
 */
export function graphReport(
  id: RecordId,
  graph: ApiGraph,
  nodes?: readonly string[],
): WorkflowGraphReport {
  const count = Object.keys(graph).length;
  const text = graphToText(graph, nodes);
  if (nodes === undefined && text.length > WORKFLOW_LIMITS.graphTextChars) {
    return {
      workflow: id,
      nodes: count,
      form: "outline",
      text: cutLines(
        graphSummary(graph).split("\n"),
        "lines",
        "name node IDs in `nodes` to read the nodes of a class",
      ),
    };
  }
  if (nodes !== undefined && text === "") {
    return {
      workflow: id,
      nodes: count,
      form: "nodes",
      text: "None of the named nodes exist in this graph.",
    };
  }
  return { workflow: id, nodes: count, form: "nodes", text: cutLines(text.split("\n"), "nodes") };
}

/**
 * Apply a patch to a template without keeping anything.
 * @param id - the workflow.
 * @param template - its graph.
 * @param ops - the patch as a caller gave it.
 * @param objectInfo - a server's node catalog, when one answered.
 * @returns the report; a patch that does not parse or apply gives `ok: false` with `error`, never a throw.
 */
export function patchReport(
  id: RecordId,
  template: ApiGraph,
  ops: unknown,
  objectInfo?: ObjectInfo,
): WorkflowPatchReport {
  const checked = objectInfo !== undefined;
  try {
    const { result, problems } = applyPatch(template, parsePatch(ops), objectInfo);
    const patched = result.graph;
    const shown = Object.keys(patched)
      .filter((nodeId) => {
        if (result.added.includes(nodeId)) return true;
        return JSON.stringify(patched[nodeId]) !== JSON.stringify(template[nodeId]);
      })
      .toSorted(compareNodeIds);
    const lines = shown.map((nodeId) => nodeLine(nodeId, patched[nodeId]!));
    return {
      workflow: id,
      ok: !hasErrors(problems),
      problems,
      added: result.added,
      removed: result.removed,
      text: lines.length === 0 ? "" : cutLines(lines, "nodes"),
      checked_against_server: checked,
    };
  } catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    return {
      workflow: id,
      ok: false,
      error: error.message,
      problems: [],
      added: [],
      removed: [],
      text: "",
      checked_against_server: checked,
    };
  }
}

/**
 * @param report - the report of a read operation.
 * @returns the text a tool result shows for it: short English lines.
 */
export function reportText(
  report: WorkflowListReport | WorkflowGetReport | WorkflowGraphReport | WorkflowPatchReport,
): string {
  if ("workflows" in report) {
    if (report.workflows.length === 0) return "No workflows.";
    return report.workflows
      .map((w) => `${w.id} ${JSON.stringify(w.name)}: ${w.nodes} nodes, ${w.fields} fields`)
      .join("\n");
  }
  if ("form" in report) return report.text;
  if ("ok" in report) {
    const lines = [report.ok ? "The patch applies." : "The patch does not apply cleanly."];
    if (report.error !== undefined) lines.push(report.error);
    lines.push(...problemLines(report.problems));
    if (report.added.length > 0) lines.push(`Added: ${report.added.join(", ")}`);
    if (report.removed.length > 0) lines.push(`Removed: ${report.removed.join(", ")}`);
    if (report.text !== "") lines.push("Nodes after the patch:", report.text);
    if (!report.checked_against_server)
      lines.push("Structure checked only; no server catalog answered.");
    return lines.join("\n");
  }
  const lines = [`${report.id} ${JSON.stringify(report.name)}: ${report.nodes} nodes`];
  if (report.description !== "") lines.push(report.description);
  for (const field of report.fields)
    lines.push(`field ${field.id} (${field.type}) = ${JSON.stringify(field.default)}`);
  if (report.parent !== null)
    lines.push(`Variant of ${report.parent.id} ${JSON.stringify(report.parent.name)}`);
  if (report.variants.length > 0)
    lines.push(`Variants: ${report.variants.map((v) => v.id).join(", ")}`);
  return lines.join("\n");
}
