// Every user-facing string of this package's browser half. Kept in one module until step 1-6
// decides whether they move into the dsh locale dictionary.

export const strings = {
  /** The product name (decided by the user, 2026-11-28: the name of the app this replaces). */
  brandName: "ComfyStudio",

  // Navigator and home
  home: "홈",
  projects: "프로젝트",
  newProject: "새 프로젝트",
  /** The title a new project starts with; the server numbers it when it is taken. */
  newProjectTitle: "새 프로젝트",
  loadingProjects: "프로젝트를 불러오는 중…",
  noProjects: "아직 프로젝트가 없습니다. ‘새 프로젝트’로 시작하세요.",
  homeLead: "프로젝트를 열거나 새로 만드세요.",
  createdOn: (date: string): string => `만든 날 ${date}`,
  projectMenu: "프로젝트 메뉴",
  rename: "이름 바꾸기",
  renameProjectLabel: "프로젝트 이름",
  removeProject: "목록에서 빼기",
  removeConfirmTitle: "프로젝트를 목록에서 뺄까요?",
  removeConfirmBody: (title: string): string =>
    `‘${title}’ 프로젝트를 목록에서 뺍니다. 프로젝트 폴더와 그 안의 파일은 디스크에 그대로 남습니다.`,
  remove: "빼기",
  cancel: "취소",
  showChats: "채팅 목록 펼치기",
  hideChats: "채팅 목록 접기",

  // Chat
  chat: "채팅",
  chatDescription: "에이전트와 대화합니다",
  newChat: "새 채팅",
  openChat: "채팅 열기",
  chatHint: "무엇을 만들지 에이전트에게 말해 보세요.",

  // Project frame
  views: "화면",
  noViews: "이 프로젝트에 표시할 화면이 아직 없습니다.",
  noViewsHint: "오른쪽 채팅에서 작업을 시작할 수 있습니다.",

  // Failures
  actionFailed: (message: string): string => `작업을 마치지 못했습니다: ${message}`,
  requestFailed: (status: number): string => `서버가 요청을 거절했습니다(HTTP ${String(status)}).`,
  unexpectedAnswer: "서버의 응답을 읽지 못했습니다.",
  workspaceNotReady: "프로젝트의 작업공간을 찾지 못했습니다. 잠시 뒤 다시 시도하세요.",
  unknownSession: "채팅을 찾지 못했습니다.",
} as const;
