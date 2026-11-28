/**
 * The screen strings of the asset component, in Korean: the labels the views show for its operations. The text an
 * agent reads (tool descriptions, summaries) is English and stays with the operations.
 *
 * @module @cs/asset/strings
 */

/** The label of each operation, by the key of `ASSET_OPERATIONS`. */
export const OPERATION_LABELS = {
  import: "가져오기",
  review: "검토",
  move: "폴더로 이동",
  tag: "태그",
  delete: "삭제",
  folderCreate: "폴더 만들기",
  folderUpdate: "폴더 수정",
  folderDelete: "폴더 삭제",
  list: "에셋 목록",
} as const;
