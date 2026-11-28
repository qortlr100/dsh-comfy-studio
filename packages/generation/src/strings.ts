/**
 * The screen strings of the generation component, in Korean: the labels the views show for its operations. The text
 * an agent reads (tool descriptions, summaries) is English and stays with the operations.
 *
 * @module @cs/generation/strings
 */

/** The label of each operation, by the key of `GEN_OPERATIONS`. */
export const OPERATION_LABELS = {
  run: "생성",
  settings: "생성 설정",
  targets: "실행 자리 목록",
  list: "생성 목록",
  get: "생성 보기",
} as const;
