import { pngTextChunks } from "./support/png-text.ts";
import { type ApiGraph, parseApiGraph } from "./workflow.ts";

/**
 * The API graph ComfyUI embeds in its output images. `SaveImage` writes two text chunks:
 * `prompt` (the API-format graph that ran) and `workflow` (the UI-format graph, which cannot be
 * queued and is ignored here). Pure logic, shared by the browser and the server.
 */

export type EmbeddedGraphResult = { graph: ApiGraph } | { graph: null; error: string };

type Entries = readonly (readonly [string, string])[];

function readPrompt(entries: Entries): EmbeddedGraphResult {
  const text = entries.find(([keyword]) => keyword === "prompt")?.[1];
  if (text === undefined)
    return { graph: null, error: "이 PNG에는 ComfyUI 워크플로(prompt)가 들어 있지 않습니다" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { graph: null, error: "PNG의 prompt 청크가 JSON이 아닙니다" };
  }
  try {
    return { graph: parseApiGraph(value) };
  } catch (err) {
    return { graph: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The API graph in the `prompt` entry of `pngTextChunks` output; null if absent or unparsable. */
export function embeddedApiGraph(entries: Entries): ApiGraph | null {
  return readPrompt(entries).graph;
}

/** A PNG file's embedded API graph; without one, `error` (Korean, for the UI) says why. */
export function graphFromPng(bytes: Uint8Array): EmbeddedGraphResult {
  try {
    return readPrompt(pngTextChunks(bytes));
  } catch (err) {
    return { graph: null, error: err instanceof Error ? err.message : String(err) };
  }
}
