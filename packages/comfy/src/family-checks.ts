import { isLinkValue } from "./graph-diff.ts";
import type { GraphProblem } from "./graph-patch.ts";
import { MODEL_LOADER_FOLDERS } from "./model-loaders.ts";
import type { CfgRange, FamilyProfile, FamilyResolver } from "./model-families.ts";
import type { ApiGraph, ApiNode } from "./workflow.ts";

/**
 * Warnings for a graph that runs a model outside the rules of its family (a size off the
 * family's grid, a CFG outside the usual range, a negative prompt the family ignores). Pure
 * logic; `validateGraph` appends them when given a resolver. Never errors: the rules are
 * guidance read from model cards, and a user may break them on purpose.
 */

const MAX_MODEL_DEPTH = 32;
const MAX_UPSTREAM_DEPTH = 16;
const LATENT_INPUTS = ["latent_image", "samples", "latent"];
const BASE_MODEL_FOLDERS = new Set(["checkpoints", "diffusion_models"]);

/** The node a link input of `node` points at, if it is a link to an existing node. */
function linkedNode(graph: ApiGraph, node: ApiNode, input: string): [string, ApiNode] | undefined {
  const v = node.inputs[input];
  // Own keys only: a link to "constructor" or "__proto__" must not reach Object.prototype.
  if (!isLinkValue(v) || !Object.hasOwn(graph, v[0])) return undefined;
  const target = graph[v[0]];
  return target ? [v[0], target] : undefined;
}

/** Follows `model` links upstream to the loader that names the base model file. */
function baseModelFile(
  graph: ApiGraph,
  start: ApiNode,
): { folder: string; file: string } | undefined {
  let node: ApiNode | undefined = start;
  const seen = new Set<ApiNode>();
  for (let depth = 0; node && depth <= MAX_MODEL_DEPTH; depth++) {
    if (seen.has(node)) return undefined;
    seen.add(node);
    const folders = MODEL_LOADER_FOLDERS[node.class_type];
    if (folders) {
      for (const [input, folder] of Object.entries(folders)) {
        const v = node.inputs[input];
        if (BASE_MODEL_FOLDERS.has(folder) && typeof v === "string") return { folder, file: v };
      }
    }
    node = linkedNode(graph, node, "model")?.[1];
  }
  return undefined;
}

/** First node upstream through `inputs` links (a chain) for which `stop` holds. */
function walkUp(
  graph: ApiGraph,
  from: ApiNode,
  input: string,
  passThrough: string[],
  stop: (node: ApiNode) => boolean,
  maxDepth: number,
): [string, ApiNode] | undefined {
  let link = linkedNode(graph, from, input);
  const seen = new Set<ApiNode>();
  for (let depth = 0; link && depth <= maxDepth; depth++) {
    const [id, node] = link;
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (stop(node)) return [id, node];
    const next = passThrough.find((name) => isLinkValue(node.inputs[name]));
    link = next ? linkedNode(graph, node, next) : undefined;
  }
  return undefined;
}

function rangeText(range: CfgRange): string {
  if (range.min !== undefined && range.max !== undefined) return `${range.min}–${range.max}`;
  if (range.max !== undefined) return `${range.max} 이하`;
  return `${range.min} 이상`;
}

function outsideRange(cfg: number, range: CfgRange): boolean {
  return (
    (range.min !== undefined && cfg < range.min) || (range.max !== undefined && cfg > range.max)
  );
}

const SAMPLERS = new Set(["KSampler", "KSamplerAdvanced", "SamplerCustomAdvanced"]);

export function familyWarnings(graph: ApiGraph, familyOf: FamilyResolver): GraphProblem[] {
  const out: GraphProblem[] = [];
  const seen = new Set<string>();
  const warn = (nodeId: string, input: string, message: string) => {
    const key = `${nodeId}\u0000${input}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ nodeId, input, message, severity: "warning" });
  };

  for (const sampler of Object.values(graph)) {
    if (!SAMPLERS.has(sampler.class_type)) continue;
    // The node that holds model, cfg and negative: the sampler itself, or its guider.
    let holder: [string, ApiNode] | undefined;
    if (sampler.class_type === "SamplerCustomAdvanced") {
      const guider = linkedNode(graph, sampler, "guider");
      if (
        guider &&
        (guider[1].class_type === "CFGGuider" || guider[1].class_type === "BasicGuider")
      )
        holder = guider;
    } else {
      holder = ["", sampler];
    }
    if (!holder) continue;
    const [holderId, holderNode] = holder;
    const modelStart = linkedNode(graph, holderNode, "model")?.[1];
    const base = modelStart && baseModelFile(graph, modelStart);
    const profile: FamilyProfile | undefined = base && familyOf(base.folder, base.file);
    if (!profile) continue;
    const name = profile.name;

    if (profile.grid) {
      const grid = profile.grid;
      const found = walkUp(
        graph,
        sampler,
        "latent_image",
        LATENT_INPUTS,
        (n) => typeof n.inputs.width === "number" && typeof n.inputs.height === "number",
        MAX_UPSTREAM_DEPTH,
      );
      if (found) {
        const [id, node] = found;
        for (const input of ["width", "height"] as const) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walkUp predicate above only accepts nodes whose width and height are numbers
          const value = node.inputs[input] as number;
          if (value % grid !== 0)
            warn(id, input, `${name} 계열은 ${grid}의 배수 크기를 씁니다 (받은 값 ${value})`);
        }
      }
    }

    const cfg = holderNode.inputs.cfg;
    if (typeof cfg !== "number") continue;
    // `holderId` is "" for a sampler holding its own cfg: find its id by identity.
    const cfgNodeId = holderId || Object.keys(graph).find((id) => graph[id] === holderNode) || "";
    if (profile.cfgRange && outsideRange(cfg, profile.cfgRange))
      warn(
        cfgNodeId,
        "cfg",
        `${name} 계열의 권장 CFG는 ${rangeText(profile.cfgRange)}입니다 (받은 값 ${cfg})`,
      );

    if (profile.negative === "zero" && cfg <= 1) {
      const hit = walkUp(
        graph,
        holderNode,
        "negative",
        ["conditioning"],
        (n) => n.class_type === "ConditioningZeroOut" || n.class_type.includes("CLIPTextEncode"),
        MAX_UPSTREAM_DEPTH,
      );
      if (hit && hit[1].class_type !== "ConditioningZeroOut") {
        const text = hit[1].inputs.text;
        if (typeof text === "string" && text.trim() !== "")
          warn(hit[0], "text", `${name} 계열은 CFG 1로 돌아 네거티브 프롬프트가 반영되지 않습니다`);
      }
    }
  }
  return out;
}
