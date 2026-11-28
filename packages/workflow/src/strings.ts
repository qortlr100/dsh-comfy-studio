/**
 * The screen strings of the workflow component, in Korean: the labels the views show for its operations. The text an
 * agent reads (tool descriptions, summaries) is English and stays with the operations.
 *
 * @module @cs/workflow/strings
 */

/** The label of each operation, by the key of `WORKFLOW_OPERATIONS`. */
export const OPERATION_LABELS = {
  create: "워크플로 가져오기",
  update: "워크플로 수정",
  saveVariant: "변형으로 저장",
  copy: "다른 프로젝트에서 복사",
  delete: "워크플로 삭제",
  list: "워크플로 목록",
  get: "워크플로 보기",
  graph: "그래프 보기",
  checkPatch: "패치 검사",
} as const;
