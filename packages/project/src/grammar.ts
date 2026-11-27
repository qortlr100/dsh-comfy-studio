/**
 * The two reference grammars of the project layer, as string functions with no state and no host import, so that the browser
 * reads and writes them with the kernel's own code (`@cs/project/grammar`).
 *
 * - A citation in a prompt: `@[<label>](cs:<kind>/<id>)`. A model provider plugin replaces the citations with the
 *   syntax of its model before the model reads the prompt.
 * - An input reference text in a call's inputs: `<asset>`, `<record>#<output>`, or `<id>@<version>`.
 *
 * @module @cs/project/grammar
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import type { AssetId, RecordInputRef } from "./types.ts";

/** One citation in a prompt. */
export interface PromptCitation {
  /** The label that the editor shows, such as `Mia · front`. */
  label: string;
  /** The `cs:` URI, such as `cs:asset/a1`. */
  uri: string;
  /** The offset of the citation's `@` in the prompt. */
  start: number;
  /** The offset after the citation's closing parenthesis. */
  end: number;
}

/** A serialized citation: `@[label](cs:...)`. */
const CITATION = /@\[([^\]]*)\]\((cs:[^)\s]+)\)/g;

/** The URI prefix of an asset citation. */
const ASSET_PREFIX = "cs:asset/";

/** The URI prefix of a citation of an input of the call by its role, such as `cs:input/first_frame`. */
const INPUT_PREFIX = "cs:input/";

const NOT_ELEMENTS = [ASSET_PREFIX, "cs:record/", INPUT_PREFIX];

/**
 * Find every citation in a prompt.
 * @param prompt - the prompt.
 * @returns the citations in prompt order.
 */
export function parsePromptCitations(prompt: string): PromptCitation[] {
  return [...prompt.matchAll(CITATION)].map((match) => {
    // The match array holds the whole text and both groups of CITATION, and every group takes part in every match.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const [text, label, uri] = match as RegExpExecArray & [string, string, string];
    return { label, uri, start: match.index, end: match.index + text.length };
  });
}

/** The text with its percent escapes decoded; null for a text with a malformed escape, such as a stray `%`. */
function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    // `decodeURIComponent` throws a URIError for a `%` that starts no escape; a URI with one names nothing.
    return null;
  }
}

/**
 * The asset that a citation URI names.
 * @param uri - a `cs:` URI.
 * @returns the asset ID of a `cs:asset/<AssetId>` URI; null for any other URI and for an ID with a malformed escape.
 */
export function citedAsset(uri: string): AssetId | null {
  const id = uri.startsWith(ASSET_PREFIX) ? decoded(uri.slice(ASSET_PREFIX.length)) : null;
  return id === null ? null : brandString<AssetId>(id);
}

/**
 * The input role that a citation URI names. A citation of an input names the call's input of that role, whatever its
 * value is, so it also names an input whose value a record has not produced yet.
 * @param uri - a `cs:` URI.
 * @returns the decoded role of a `cs:input/<role>` URI, such as `first_frame`; null for any other URI and for a role
 *   with a malformed escape.
 */
export function citedInput(uri: string): string | null {
  return uri.startsWith(INPUT_PREFIX) ? decoded(uri.slice(INPUT_PREFIX.length)) : null;
}

/**
 * The element that a citation URI names: a `cs:<kind>/<id>` URI whose kind is not `asset`, `record` or `input`.
 * @param uri - a `cs:` URI.
 * @returns the kind and the decoded ID, or null.
 */
export function citedElement(uri: string): { kind: string; id: string } | null {
  return NOT_ELEMENTS.some((prefix) => uri.startsWith(prefix)) ? null : citationTarget(uri);
}

/**
 * The kind and the ID that a citation URI names, whatever the kind; {@link formatCitation} writes them back.
 * @param uri - a `cs:` URI.
 * @returns the kind and the decoded ID of a `cs:<kind>/<id>` URI, or null for any other text and for an ID with a
 *   malformed escape.
 */
export function citationTarget(uri: string): { kind: string; id: string } | null {
  const slash = uri.indexOf("/");
  const id = uri.startsWith("cs:") && slash >= 0 ? decoded(uri.slice(slash + 1)) : null;
  return id === null ? null : { kind: uri.slice("cs:".length, slash), id };
}

function encodeId(id: string): string {
  return encodeURIComponent(id).replaceAll("(", "%28").replaceAll(")", "%29");
}

/**
 * Write one citation, the one writer of the citation grammar. An empty label becomes the ID; the label then loses `]`,
 * and each line break becomes one space, so every citation it writes reads back and matches DSH's wire form of a
 * reference.
 * @param label - the label that the editor shows.
 * @param kind - the URI kind, such as `asset`, `character` or `input`.
 * @param id - the ID, such as an asset ID or an element ID.
 * @returns `@[label](cs:<kind>/<id>)`.
 */
export function formatCitation(label: string, kind: string, id: string): string {
  const written = (label === "" ? id : label).replaceAll("]", "").replaceAll(/\r\n|\r|\n/gu, " ");
  return `@[${written}](${citationUri(kind, id)})`;
}

/**
 * The URI of one citation.
 * @param kind - the URI kind.
 * @param id - the ID.
 * @returns `cs:<kind>/<id>`, with the ID encoded as {@link formatCitation} encodes it.
 */
export function citationUri(kind: string, id: string): string {
  return `cs:${kind}/${encodeId(id)}`;
}

/**
 * The reference kind, ID and version of a version reference.
 * @param ref - a record input reference.
 * @returns them, or null for an asset or a record output.
 */
export function versionRefOf(
  ref: RecordInputRef,
): { kind: string; id: string; version: number } | null {
  if ("asset" in ref || "record" in ref) return null;
  const fields: Record<string, string | number> = ref;
  const kind = Object.keys(fields).find((key) => key !== "version");
  return kind === undefined
    ? null
    : { kind, id: String(fields[kind]), version: Number(fields["version"]) };
}

/**
 * The citation URI of the element that an input reference is a version of: `cs:<kind>/<id>`, with the reference kind.
 * A prompt cites an element without a version; the reference names the version.
 * @param ref - an input reference, such as a `reference` input of a generation call.
 * @returns the URI; null for a reference to an asset or to a record output.
 */
export function elementCitationUri(ref: RecordInputRef): string | null {
  const named = versionRefOf(ref);
  return named === null ? null : citationUri(named.kind, named.id);
}

/** The syntax of one input reference text, read with no state: the kind of a version is found in the state. */
export type InputRefSyntax =
  | { readonly asset: string }
  | { readonly record: string; readonly output: number }
  | { readonly id: string; readonly version: number };

/**
 * Split one input reference text by its syntax: `<record>#<n>` names output n of a record, `<id>@<n>` names version n
 * of an element, and anything else names an asset.
 * @param text - the reference text.
 * @returns the syntax.
 */
export function splitInputRef(text: string): InputRefSyntax {
  const hash = text.lastIndexOf("#");
  const output = hash > 0 ? Number(text.slice(hash + 1)) : Number.NaN;
  if (Number.isInteger(output) && output >= 0) return { record: text.slice(0, hash), output };
  const at = text.lastIndexOf("@");
  const version = at > 0 ? Number(text.slice(at + 1)) : Number.NaN;
  if (!Number.isInteger(version)) return { asset: text };
  return { id: text.slice(0, at), version };
}

/**
 * Write one input reference syntax as text; {@link splitInputRef} reads it back.
 * @param syntax - the syntax.
 * @returns an asset ID, `<record>#<output>`, or `<id>@<version>`.
 */
export function formatInputSyntax(syntax: InputRefSyntax): string {
  if ("asset" in syntax) return syntax.asset;
  if ("record" in syntax) return `${syntax.record}#${String(syntax.output)}`;
  return `${syntax.id}@${String(syntax.version)}`;
}

/**
 * Write one record input reference as the text that {@link splitInputRef} reads back.
 * @param ref - the reference.
 * @returns an asset ID, `<record>#<output>`, or `<id>@<version>` for a version.
 */
export function formatInputRef(ref: RecordInputRef): string {
  if ("asset" in ref || "record" in ref) return formatInputSyntax(ref);
  const named = versionRefOf(ref);
  return named === null ? JSON.stringify(ref) : formatInputSyntax(named);
}
