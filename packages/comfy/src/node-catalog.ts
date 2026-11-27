import type { ComfyBackend } from "./backend.ts";
import {
  inputSpecOptions,
  inputSpecType,
  type InputSpec,
  type NodeInfo,
  type ObjectInfo,
} from "./workflow.ts";

/**
 * A server's node catalog (its whole `/object_info`): fetched through the backend, kept for a
 * few minutes per server, and searched or described for the agent. The cache key includes the
 * server row's `updatedAt`, so editing a server (new URL, new kind) drops its catalog without
 * the service having to know about this module; a deleted server's entry ages out.
 */

export const CATALOG_TTL_MS = 5 * 60_000;
/** Catalogs are megabytes each; keep only a handful. */
const MAX_ENTRIES = 6;

interface Entry {
  serverId: string;
  at: number;
  catalog: Promise<ObjectInfo>;
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis has no declared cache key; the cache is process-wide and only this module reads it
const globalForCatalogs = globalThis as unknown as { csComfyNodeCatalogs?: Map<string, Entry> };
function store(): Map<string, Entry> {
  globalForCatalogs.csComfyNodeCatalogs ??= new Map();
  return globalForCatalogs.csComfyNodeCatalogs;
}

export interface CatalogServer {
  id: string;
  updatedAt: Date;
}

/**
 * The catalog of `server`, from the cache when fresh. A failed fetch is not kept, so the next
 * call tries again. Concurrent callers share one in-flight fetch.
 */
export function nodeCatalogFor(
  server: CatalogServer,
  client: ComfyBackend,
  now = Date.now(),
): Promise<ObjectInfo> {
  const key = `${server.id}:${server.updatedAt.getTime()}`;
  const map = store();
  const hit = map.get(key);
  if (hit && now - hit.at < CATALOG_TTL_MS) return hit.catalog;
  for (const [k, e] of map) if (e.serverId === server.id) map.delete(k);
  const catalog = client.listNodeClasses();
  const entry: Entry = { serverId: server.id, at: now, catalog };
  map.set(key, entry);
  catalog.catch(() => {
    if (map.get(key) === entry) map.delete(key);
  });
  while (map.size > MAX_ENTRIES) {
    let oldest: [string, Entry] | undefined;
    for (const pair of map) if (!oldest || pair[1].at < oldest[1].at) oldest = pair;
    map.delete(oldest![0]);
  }
  return catalog;
}

/**
 * Forgets the cached catalog of one server, so the next `nodeCatalogFor` asks the server again.
 * For a caller the user asked to re-read the server (a model re-scan), where a minutes-old
 * answer would be written back as fresh.
 */
export function forgetNodeCatalog(serverId: string): void {
  const map = store();
  for (const [k, e] of map) if (e.serverId === serverId) map.delete(k);
}

/** Forgets every cached catalog (tests). */
export function clearNodeCatalogs(): void {
  store().clear();
}

export interface NodeClassMatch {
  classType: string;
  displayName: string | null;
  category: string | null;
  outputs: string[];
}

function outputTypes(info: NodeInfo): string[] {
  return (info.output ?? []).map((t) => (typeof t === "string" ? t : "*"));
}

/**
 * Classes whose name, display name, category or description contain every word of `query`,
 * best first: exact class name, then class name containing the query, then display name,
 * then the words spread over name and display name, then category/description only.
 */
export function searchNodeClasses(
  catalog: ObjectInfo,
  query: string,
  limit = 20,
): { total: number; matches: NodeClassMatch[] } {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { total: 0, matches: [] };
  const compact = words.join("");
  const scored: { score: number; match: NodeClassMatch }[] = [];
  for (const [classType, info] of Object.entries(catalog)) {
    const name = classType.toLowerCase();
    const display = info.display_name?.toLowerCase() ?? "";
    const category = info.category?.toLowerCase() ?? "";
    const description = info.description?.toLowerCase() ?? "";
    const all = `${name} ${display} ${category} ${description}`;
    if (!words.every((w) => all.includes(w))) continue;
    const nameAndDisplay = `${name} ${display}`;
    const score =
      name === q || name === compact
        ? 0
        : name.includes(compact) || name.includes(q)
          ? 1
          : display.includes(q)
            ? 2
            : words.every((w) => nameAndDisplay.includes(w))
              ? 3
              : 4;
    scored.push({
      score,
      match: {
        classType,
        displayName: info.display_name ?? null,
        category: info.category ?? null,
        outputs: outputTypes(info),
      },
    });
  }
  scored.sort((a, b) => a.score - b.score || a.match.classType.localeCompare(b.match.classType));
  return { total: scored.length, matches: scored.slice(0, limit).map((s) => s.match) };
}

export interface NodeInputDescription {
  name: string;
  required: boolean;
  /** `INT`, `FLOAT`, `STRING`, `BOOLEAN`, `COMBO`, or a link type such as `MODEL`. */
  type: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
  /** First `maxOptions` choices of a COMBO; `optionCount` is the full number when cut. */
  options?: string[];
  optionCount?: number;
}

export interface NodeClassDescription {
  classType: string;
  displayName: string | null;
  category: string | null;
  description: string | null;
  outputNode: boolean;
  inputs: NodeInputDescription[];
  outputs: { index: number; type: string; name: string }[];
}

function describeInput(
  name: string,
  spec: InputSpec,
  required: boolean,
  maxOptions: number,
): NodeInputDescription {
  const opts = spec[1] ?? {};
  const out: NodeInputDescription = { name, required, type: inputSpecType(spec) };
  if (opts.default !== undefined) out.default = opts.default;
  for (const k of ["min", "max", "step"] as const)
    if (typeof opts[k] === "number") out[k] = opts[k];
  if (opts.multiline === true) out.multiline = true;
  const options = inputSpecOptions(spec);
  if (options) {
    out.options = options.slice(0, maxOptions);
    if (options.length > maxOptions) out.optionCount = options.length;
  }
  return out;
}

/** One class as the agent reads it, or null when the catalog has no such class. */
export function describeNodeClass(
  catalog: ObjectInfo,
  classType: string,
  maxOptions = 40,
): NodeClassDescription | null {
  const info = catalog[classType];
  if (!info) return null;
  const inputs: NodeInputDescription[] = [];
  for (const [section, required] of [
    ["required", true],
    ["optional", false],
  ] as const) {
    for (const [name, spec] of Object.entries(info.input?.[section] ?? {}))
      if (Array.isArray(spec)) inputs.push(describeInput(name, spec, required, maxOptions));
  }
  const types = outputTypes(info);
  return {
    classType,
    displayName: info.display_name ?? null,
    category: info.category ?? null,
    description: info.description || null,
    outputNode: info.output_node === true,
    inputs,
    outputs: types.map((type, index) => ({
      index,
      type,
      name: info.output_name?.[index] ?? type,
    })),
  };
}
