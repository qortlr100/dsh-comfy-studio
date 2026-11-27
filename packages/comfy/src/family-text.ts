import type { GraphModelFamily } from "./types.ts";
import { familyProfile, type FamilyEvidence, type FamilyProfile } from "./model-families.ts";

/**
 * The model-family paragraph of the workflow context: what the template's base models and LoRAs
 * are and what their family expects, in the words the agent reads. Pure logic over the judged
 * loader inputs (`familiesOfGraph`), shared with tests.
 */

/** LoRA trigger words listed per file. */
export const CONTEXT_TRIGGER_WORDS = 12;
/** Model files listed; a graph with more gets a count for the rest. */
export const CONTEXT_MODEL_FILES = 12;

const EVIDENCE: Record<FamilyEvidence, string> = {
  metadata: "from the file's metadata",
  filename: "from the file name",
  declared: "set by the user",
  unknown: "",
  conflict: "",
};

const NEGATIVE: Record<FamilyProfile["negative"], string> = {
  text: "negative prompt: used",
  zero: "negative prompt: ignored (runs at CFG 1) — leave it empty or zeroed",
  none: "negative prompt: none (the workflow has no negative conditioning)",
};

const STYLE: Record<FamilyProfile["promptStyle"], string> = {
  tags: "prompt: comma-separated tags",
  natural: "prompt: natural-language sentences",
  mixed: "prompt: tags or natural language",
};

function defaultsText(profile: FamilyProfile): string | null {
  const d = profile.defaults;
  const parts = [
    d.width && d.height ? `${d.width}×${d.height}` : null,
    d.frames ? `${d.frames} frames` : null,
    d.fps ? `${d.fps} fps` : null,
    d.steps ? `${d.steps} steps` : null,
    d.cfg ? `cfg ${d.cfg}` : null,
    d.guidance ? `guidance ${d.guidance}` : null,
    d.sampler ? (d.scheduler ? `${d.sampler}/${d.scheduler}` : d.sampler) : null,
  ].filter((p) => p !== null);
  return parts.length > 0 ? `usual values ${parts.join(" · ")}` : null;
}

function cfgText(profile: FamilyProfile): string | null {
  const { min, max } = profile.cfgRange ?? {};
  if (min !== undefined && max !== undefined) return `cfg range ${min}–${max}`;
  if (max !== undefined) return `cfg at most ${max}`;
  if (min !== undefined) return `cfg at least ${min}`;
  return null;
}

function profileText(profile: FamilyProfile): string {
  return [
    profile.grid ? `width and height in multiples of ${profile.grid}` : null,
    defaultsText(profile),
    cfgText(profile),
    NEGATIVE[profile.negative],
    STYLE[profile.promptStyle],
    profile.latentNode ? `latent node ${profile.latentNode}` : null,
    profile.samplingNode ? `model-sampling node ${profile.samplingNode}` : null,
  ]
    .filter((p) => p !== null)
    .join("; ");
}

interface FileEntry {
  item: GraphModelFamily;
  nodeIds: string[];
}

/** One entry per model file, with every node that loads it. */
function byFile(items: readonly GraphModelFamily[]): FileEntry[] {
  const out = new Map<string, FileEntry>();
  for (const item of items) {
    const key = `${item.folder}\u0000${item.file}`;
    const entry = out.get(key);
    if (entry) {
      if (!entry.nodeIds.includes(item.nodeId)) entry.nodeIds.push(item.nodeId);
    } else out.set(key, { item, nodeIds: [item.nodeId] });
  }
  return [...out.values()];
}

/** Longest file name or trigger word put in a line. */
const CONTEXT_NAME_CHARS = 200;

/**
 * A name from a graph or a model file as one bounded piece of a line: control characters
 * (line breaks above all) become spaces, so text from an imported workflow or a downloaded
 * LoRA's metadata cannot start lines of its own in the system prompt.
 */
function inline(text: string): string {
  // oxlint-disable-next-line eslint/no-control-regex -- strips control characters and line separators on purpose
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  return flat.length > CONTEXT_NAME_CHARS ? `${flat.slice(0, CONTEXT_NAME_CHARS)}…` : flat;
}

function nodesText(ids: string[]): string {
  return `node${ids.length > 1 ? "s" : ""} ${ids.map(inline).join(", ")}`;
}

function unknownText(evidence: FamilyEvidence): string {
  return evidence === "conflict"
    ? "family unclear (the file name fits several families) — ask the user which it is before changing sampler settings"
    : "family unknown — ask the user, or check its model card (web_search), before changing sampler settings";
}

/**
 * Lines for the workflow context, or an empty list when the graph loads no base model or LoRA.
 * Base models come first with their family's rules, then LoRAs with their trigger words.
 */
export function familyContextLines(items: readonly GraphModelFamily[]): string[] {
  const files = byFile(items);
  const base = files.filter((f) => f.item.folder !== "loras");
  const loras = files.filter((f) => f.item.folder === "loras");
  if (base.length + loras.length === 0) return [];
  const baseFamilies = new Set(base.map((f) => f.item.familyId).filter((id) => id !== null));
  const lines = [
    "Models this template loads, and what their model family expects (go by these, not by generic Stable Diffusion habits; they are guidance, the template's own values may differ on purpose):",
  ];
  const shown = [...base, ...loras].slice(0, CONTEXT_MODEL_FILES);
  for (const { item, nodeIds } of shown) {
    const lora = item.folder === "loras";
    const head = `- ${lora ? "LoRA " : ""}${inline(item.file)} (${nodesText(nodeIds)})`;
    const profile = familyProfile(item.familyId, item.file);
    if (!lora) {
      lines.push(
        profile
          ? `${head}: ${profile.name} (${EVIDENCE[item.evidence]}). ${profileText(profile)}. ${profile.notes}`
          : `${head}: ${unknownText(item.evidence)}.`,
      );
      continue;
    }
    const words = item.triggerWords.slice(0, CONTEXT_TRIGGER_WORDS).map(inline).filter(Boolean);
    const parts = [
      profile ? `for ${profile.family.name} (${EVIDENCE[item.evidence]})` : "base family unknown",
      profile && baseFamilies.size > 0 && !baseFamilies.has(profile.family.id)
        ? "a different family than the base model here — it may not apply"
        : null,
      words.length > 0
        ? `trigger words: ${words.join(", ")}${item.triggerWords.length > CONTEXT_TRIGGER_WORDS ? ", …" : ""}`
        : null,
    ].filter((p) => p !== null);
    lines.push(`${head}: ${parts.join("; ")}.`);
  }
  const rest = files.length - shown.length;
  if (rest > 0) lines.push(`- (${rest} more model files not listed)`);
  return lines;
}
