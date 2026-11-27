/**
 * A gallery image handed over to a workflow's image field (`?asset=&field=&t=` on the workflow
 * page). Pure, shared by the server page that reads the query and the client form that acts on
 * it; nothing here may import server-only or client-only modules.
 */

/** A gallery asset to copy into the server's input folder as soon as the field is ready. */
export interface PendingAsset {
  assetId: string;
  filename: string;
  /** Identifies one hand-over, so sending the same asset again later is not mistaken for a repeat. */
  key: string;
}

/** A hand-over bound to one image field. */
export interface IncomingAsset extends PendingAsset {
  fieldId: string;
}

/** Key of the hand-over named by `?asset=&field=&t=`; the page and the form derive it alike. */
export function incomingAssetKey(q: { get(name: string): string | null | undefined }): string {
  return `${q.get("asset") ?? ""}:${q.get("field") ?? ""}:${q.get("t") ?? ""}`;
}
