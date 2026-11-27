/**
 * Pattern matching for a preset's `modelPatterns`: which model files a pattern applies to.
 * Pure logic shared by the service, the settings form and tests.
 */

const MAX_PATTERN_LENGTH = 200;

/** Trims, drops empties and duplicates (case-insensitively), keeps the user's spelling. */
export function normalizeModelPatterns(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim().slice(0, MAX_PATTERN_LENGTH);
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `file` (a model loader value such as `flux/flux1-dev.safetensors`) matches `pattern`.
 * Case-insensitive. A pattern without `*` is a substring of the value (folder part included, so
 * `flux/` works). A pattern with `*` is a glob (`*` = any run of characters) that must cover the
 * whole value or the whole file name after the last folder separator, so `flux1-*.safetensors`
 * matches whether or not the model sits in a subfolder.
 */
export function matchesModelPattern(pattern: string, file: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const f = file.toLowerCase();
  if (!p.includes("*")) return f.includes(p);
  const re = new RegExp(`^${p.split("*").map(escapeRegExp).join(".*")}$`, "s");
  if (re.test(f)) return true;
  const base = f.slice(Math.max(f.lastIndexOf("/"), f.lastIndexOf("\\")) + 1);
  return base !== f && re.test(base);
}

/** Whether any pattern matches any of the files. */
export function matchesAnyModel(patterns: readonly string[], files: readonly string[]): boolean {
  return patterns.some((p) => files.some((f) => matchesModelPattern(p, f)));
}
