/**
 * The citations of a prompt, read with the citation grammar of `grammar.ts`: the assets that a prompt cites, and the
 * replacement of each citation. Project owns the grammar because the project holds the records and the assets that the
 * citations name.
 *
 * @module @cs/project/citations
 */
import { citedAsset, parsePromptCitations, type PromptCitation } from "./grammar.ts";
import type { AssetId } from "./types.ts";

/**
 * The assets that a prompt cites, each once.
 * @param prompt - the prompt.
 * @returns the asset IDs in the order of their first citation.
 */
export function promptAssets(prompt: string): AssetId[] {
  return [
    ...new Set(parsePromptCitations(prompt).flatMap((citation) => citedAsset(citation.uri) ?? [])),
  ];
}

/**
 * Replace each citation of a prompt with text.
 * @param prompt - the prompt.
 * @param replace - the text for one citation.
 * @returns the prompt with every citation replaced.
 */
export function replacePromptCitations(
  prompt: string,
  replace: (citation: PromptCitation) => string,
): string {
  let text = "";
  let last = 0;
  for (const citation of parsePromptCitations(prompt)) {
    text += prompt.slice(last, citation.start) + replace(citation);
    last = citation.end;
  }
  return text + prompt.slice(last);
}
