import type { InputSpec, ObjectInfo } from "../workflow.ts";
import { classifyOutput } from "../protocol.ts";
import type { MediaKind } from "../types.ts";

/** The media kind an upload-style combo lists (`image_upload`, `audio_upload`, `video_upload`). */
export function uploadKindOf(opts: Record<string, unknown> | undefined): MediaKind | null {
  if (opts?.image_upload === true) return "image";
  if (opts?.audio_upload === true) return "audio";
  if (opts?.video_upload === true) return "video";
  return null;
}

/** True when any input of any class is an upload-style combo. */
export function hasUploadInput(info: ObjectInfo): boolean {
  return Object.values(info).some((n) =>
    (["required", "optional"] as const).some((section) =>
      Object.values(n.input?.[section] ?? {}).some(
        (spec) => Array.isArray(spec) && uploadKindOf(spec[1]) !== null,
      ),
    ),
  );
}

/**
 * Node definitions for a RunPod worker come from the snapshot it writes on start to the
 * volume (`meta/object_info.json`: the worker's own `/object_info`, volume models included).
 * Pure helpers over that snapshot; the client fetches and caches it.
 */

/** Picks the requested classes out of a full `/object_info` body. Unknown classes are absent. */
export function pickNodeInfo(snapshot: unknown, classes: string[]): ObjectInfo {
  const out: ObjectInfo = {};
  if (!snapshot || typeof snapshot !== "object") return out;
  for (const c of classes) {
    const info: unknown = Reflect.get(snapshot, c);
    if (info && typeof info === "object") out[c] = info;
  }
  return out;
}

/**
 * Replaces the choices of every upload-style input (`image_upload`, `audio_upload`,
 * `video_upload`, as LoadImage, LoadAudio and LoadVideo declare) with the volume's current
 * `input/` listing, narrowed to that kind's file types the way ComfyUI's own loaders filter the
 * folder. The snapshot's list is whatever the folder held when the worker started; the runner
 * uploads there since. Returns a new object.
 */
export function withInputFiles(objectInfo: ObjectInfo, files: string[]): ObjectInfo {
  const byKind = new Map<MediaKind, string[]>();
  const filesOf = (kind: MediaKind) => {
    let list = byKind.get(kind);
    if (!list) {
      list = files.filter((f) => classifyOutput(f).kind === kind);
      byKind.set(kind, list);
    }
    return list;
  };
  const out: ObjectInfo = {};
  for (const [classType, info] of Object.entries(objectInfo)) {
    let next = info;
    for (const section of ["required", "optional"] as const) {
      for (const [input, spec] of Object.entries(info.input?.[section] ?? {})) {
        const kind = Array.isArray(spec) ? uploadKindOf(spec[1]) : null;
        if (!kind) continue;
        if (next === info) next = structuredClone(info);
        const listed = filesOf(kind);
        const replaced: InputSpec = Array.isArray(spec[0])
          ? [listed, spec[1]]
          : [spec[0], { ...spec[1], options: listed }];
        next.input![section]![input] = replaced;
      }
    }
    out[classType] = next;
  }
  return out;
}

/** Top-level file names under `input/`, sorted for a stable choice list. */
export function inputFileNames(keys: string[]): string[] {
  return keys
    .flatMap((k) => (k.startsWith("input/") ? [k.slice("input/".length)] : []))
    .filter((name) => name.length > 0 && !name.includes("/"))
    .toSorted((a, b) => a.localeCompare(b));
}
