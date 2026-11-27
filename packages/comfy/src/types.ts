/**
 * Value sets the library shares with its callers. In the app this library came from they lived
 * in the database schema and the upload helpers; here they are the library's own.
 */
import type { FamilyEvidence } from "./model-families.ts";

/** What speaks on the other side of a `ComfyBackend`. */
export const COMFY_SERVER_KINDS = ["local", "cloud", "runpod", "modal"] as const;
export type ComfyServerKind = (typeof COMFY_SERVER_KINDS)[number];

/** Where a generation stands. */
export const GENERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/** What an output file is stored as. */
export const ASSET_KINDS = ["image", "video", "audio", "file"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** The media a workflow field takes as an uploaded input. */
export const MEDIA_KINDS = ["image", "audio", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** One model-loader input of a graph and the family of the file it names. */
export interface GraphModelFamily {
  nodeId: string;
  input: string;
  folder: string;
  file: string;
  familyId: string | null;
  evidence: FamilyEvidence;
  /** A LoRA's trigger words from the server's scan; empty when not scanned. */
  triggerWords: string[];
}
