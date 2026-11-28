# 단계 계획 — 3-0 셸

`docs/ROADMAP.md` 3-0의 상세 계획이다. 브랜치는 `3-0-shell`이다(2026-11-28). 끝났다. 만든 것과 계획에서 달라진 것은 맨 아래 "결과"에 있다.

## 범위

기본 dsh 화면을 우리 셸로 교체한다(`@cs/ui-shell`의 브라우저 절반).

- 브랜드(이름과 마크).
- 왼쪽 사이드바의 내비게이터: 홈, 프로젝트 목록, 프로젝트 만들기·이름 바꾸기·빼기.
- 가운데: 프로젝트가 열려 있지 않을 때의 홈, 열려 있을 때의 프로젝트 틀(위쪽 줄과 화면이 꽂히는 자리).
- 채팅을 우측 패널의 탭으로.
- 슬롯이 없는 기본 요소 가운데 숨기거나 막을 것.
- 1-1의 시험용 React 컴포넌트(`BuildProbe`)를 지운다.

범위 밖: 가운데에 꽂히는 실제 화면(갤러리는 3-2), 자체 부품과 디자인 문서(3-1), 채팅 안의 카드(3-4), 설정 화면(3-5), 에이전트 프리셋(1-4), 실제 모델로 메시지가 오가는지(1-3), 한국어 언어 팩(1-6).

## 설계에 쓴 사실

날짜를 따로 적지 않은 것은 2026-11-28에 확인했다.

- **기본 화면의 DOM**(**띄워 확인**: 임시 home으로 dsh 0.2.2-rc.5를 띄워 윤곽을 찍었다). 왼쪽 사이드바는 위에서부터 브랜드 줄(`button._brand`, 누르면 새 세션. 안에 슬롯 `sidebar.brand.mark`·`sidebar.brand.name`), 새 세션 줄(슬롯 `sidebar.session.action`이 버튼 `_newSession`을 감싼다), 패널 목록(`nav._panelList`: Plugins, Automation tasks, More), 슬롯 `sidebar.workspaces`(작업공간과 세션의 나무), 발치(슬롯 `sidebar.footer.action`, `sidebar.settings`)다. 가운데는 `main` → `main.conversation`이고 세션이 없으면 dsh의 첫 화면(작업공간 고르기와 입력창)이 뜬다. 브라우저 탭 제목은 "DeepSeek Harness"다.
- **새 세션 버튼은 슬롯으로 바꿀 수 있다**(**소스 확인**: 업스트림 `packages/client/ui-sidebar/src/client/contract/slots.ts`). `sidebar.session.action`은 `hoc` 슬롯이고, 차지한 React 컴포넌트가 버튼을 `children`으로 받아 무엇을 그릴지 정한다. DreamVerse가 갈라진 뒤에 생긴 슬롯이라 DreamVerse는 이 버튼을 CSS 클래스 접미사로 숨겼다.
- **dsh가 주 세션을 고르는 법**(**소스 확인**: 업스트림 `packages/client/ui-workspace/src/client/navigation.ts`). 기동 때 저장해 둔 세션을 다시 연다. 없으면 가장 최근 작업공간의 빈 세션을 열고, 작업공간과 세션이 하나도 없으면 `workspaces.initializeDefault()`로 기본 작업공간(`<문서 폴더>/deepseek-harness/default-workspace`)을 만든다. 그것이 실패하면 "Unable to create default workspace" 토스트가 뜬다(임시 home에서 **띄워 확인**). `uiWorkspace.openWorkspace(id)`는 그 작업공간의 빈 세션을 다시 쓰거나 새로 만들어 주 세션으로 연다. `uiWorkspace.startSession()`(새 세션 버튼, 브랜드, 단축키)은 지금 세션의 작업공간, 없으면 가장 최근 작업공간에서 같은 일을 한다. `uiWorkspace.openSession(id)`는 주 세션을 바꾼다.
- **우측 패널**(**소스 확인**: 업스트림 `packages/client/ui-sidebar-right/src/client/service.ts`). 패널의 탭은 세션마다 따로 있다. `ctx.sidebarRight.mounted`는 지금 화면에 자리가 마운트된 세션을 주는 관찰 가능한 값이다. `openTab(kind)`는 마운트된 자리가 없으면 던진다. `isExpanded()`와 `toggleExpanded()`가 있다. 펼침 여부를 구독하는 값(`expanded`)은 없다(DreamVerse 포크에만 있다).
- **레이아웃**(**소스 확인**: 업스트림 `packages/client/ui-layout/src/client/service.ts`). `ctx.layout.selectPanel(id | null)`이 가운데를 dsh의 페이지(Plugins 등)와 대화 사이에서 바꾼다. `beginNavigation()`은 진행 중인 내비게이션(기동 때의 세션 복원 포함)을 끊는다.
- **프로젝트 id는 작업공간 id다**(**소스 확인**: `packages/project/src/types.ts`의 `ProjectInfo`). 화면용 API의 프로젝트 라우트는 2-2에서 만들었다(`docs/ARCHITECTURE.md` "화면용 API").
- **DreamVerse의 셸**(**소스 확인(DreamVerse)**: `packages/dv/ui-shell/src/client/`, 소스 2,846줄). `actions.ts`(dsh 서비스로 하는 이동), `store.ts`(열린 프로젝트와 프로젝트 목록, URL 해시 미러), `Center.tsx`(입구 화면과 작업 화면), `Navigator.tsx`(프로젝트와 세션의 나무), `SessionSwitcher.tsx`(위쪽 줄의 세션 전환기), `tabs.tsx`(채팅·궤적 탭), `chrome.tsx`(숨김과 문구 바꾸기)로 되어 있다.
- **DreamVerse 셸에서 가져올 수 없는 것**: 입구 화면의 채팅은 첫 메시지를 보낼 때 프로젝트를 자동으로 만드는데, 그 장치가 포크 전용 이벤트 `conversation/before-send`다(0.2.2-rc.5의 소스에 없다). `sidebarRight.expanded` 구독도 포크 전용이다(`docs/DSH.md` "포크에서만 되는 것").
- **브라우저 탭 제목**은 dsh의 빌드 상수(`DSH_CLIENT_TITLE`)이거나 로케일 사전의 `brand.localBuild`다(**소스 확인**: 업스트림 `packages/client/ui-layout/src/client/AppFrame.tsx`). 플러그인이 바꾸는 공개된 길은 없다.

## 사용자가 정할 것

`docs/DECISIONS.md` "미정"의 "화면에 쓸 제품 이름과 마크, 숨길 기본 요소, 프로젝트 하나에 둘 세션 수"였다. 아래 안을 보였고 **사용자가 셋 모두 권한 안을 골랐다(2026-11-28)**: 이름은 ComfyStudio이고 단순 마크를 둔다, 숨김은 "최소", 세션은 여럿이고 내비게이터에서 고른다. 이 셋에 걸린 부분(브랜드, 숨김, 내비게이터의 세션 줄)은 답을 받은 뒤에 만들었다.

### 1. 제품 이름과 마크

| 안 | 이름 | 마크 | 장점 | 단점 |
| --- | --- | --- | --- | --- |
| **이름 + 단순 마크(권함)** | ComfyStudio(기존 앱 이름) | 직접 그린 단순한 SVG(둥근 사각형 안의 글자 C). dsh 색 토큰으로 칠한다 | 접힌 사이드바에도 마크가 보인다. 숨김 장치가 필요 없다 | 마크가 임시다(3-1의 디자인 문서에서 다시 본다) |
| 이름만 | ComfyStudio | 없음(dsh의 고래를 지운다) | 가장 단순하다 | 접힌 사이드바의 마크 자리가 비어 CSS 접미사 장치로 메워야 한다 |
| 다른 이름 | 사용자가 준다 | 위 둘 중 하나 | — | — |

어느 안이든 브라우저 탭 제목과 파비콘은 dsh의 것 그대로 둔다. 바꾸려면 dsh 내부에 기대는 장치(사전 문자열 바꾸기, `<head>`의 링크 갈아 끼우기)가 필요하다.

### 2. 숨기거나 막을 기본 요소

슬롯으로 교체하는 것(가운데, 작업공간 목록, 브랜드)은 여기 넣지 않았다. "장치"는 `docs/DSH.md` "dsh 내부에 기대는 장치"의 종류다.

| 요소 | 최소(권함) | DreamVerse와 같게 | 교체만 | 방법 |
| --- | --- | --- | --- | --- |
| 새 세션 버튼 | "새 프로젝트" 버튼으로 바꾼다 | 같다 | 같다 | 슬롯 `sidebar.session.action`(장치 아님) |
| 브랜드를 누르면 새 세션이 열리는 것 | 막는다 | 막는다 | 그대로 | 장치: CSS 클래스 접미사 |
| 첫 실행 때 기본 작업공간을 자동으로 만드는 것 | 막는다 | 막는다 | 그대로 | 장치: 서비스 함수 덮어쓰기(`workspaces.initializeDefault`) |
| 패널 목록(Plugins, Automation tasks, More) | 그대로 | 숨기고 내비게이터에 다시 나열한다 | 그대로 | 장치: CSS 클래스 접미사 |
| 입력창의 통계 알약, 컨텍스트 사용량, 슬래시 명령, 명령 별칭 | 그대로 | 숨긴다 | 그대로 | 슬롯 하나, 장치 셋 |
| 첫 실행의 Preview Notice 창 | 그대로 | 건너뛴다 | 그대로 | 슬롯 `settings.onboarding` |
| 우측 패널의 새 탭 안내(dsh의 탭 종류: 파일, 터미널 등) | 그대로 | 우리 탭만 보이게 바꾼다 | 그대로 | 슬롯 `sidebar.right.tab.guide` |

- **최소**를 권하는 이유: dsh가 주는 기능(플러그인, 예약, 슬래시 명령, 파일·터미널 탭)을 그대로 쓰는 것이 "dsh로 변경 할수 있는건 dsh로 변경"에 맞고, 내부 장치가 둘뿐이라 버전을 올릴 때 다시 볼 것이 적다. 막는 둘은 프로젝트 밖의 세션이 생기는 길이다: 브랜드를 누르면 홈에서 가장 최근 프로젝트의 채팅으로 넘어가 버리고, 기본 작업공간은 어느 프로젝트에도 속하지 않는 세션을 만든다(실패하면 토스트가 뜬다).
- **DreamVerse와 같게**는 사용자가 제작자 한 부류인 제품의 선택이다. 내부 장치가 여섯으로 는다.
- **교체만**은 내부 장치가 없다. 대신 첫 실행 때 문서 폴더에 dsh의 기본 작업공간이 생기거나 토스트가 뜬다.

### 3. 프로젝트 하나에 둘 세션 수

| 안 | 내비게이터 | 위쪽 줄 | 장점 | 단점 |
| --- | --- | --- | --- | --- |
| **여럿, 내비게이터에서 고른다(권함)** | 열린 프로젝트 아래에 그 프로젝트의 채팅 목록과 "새 채팅" | 프로젝트 이름과 채팅 열기 버튼 | dsh의 세션 기능(새 세션 단축키, 포크, 보관)이 그대로 맞는다. 긴 작업을 주제별로 나눌 수 있다 | 내비게이터가 두 단이다 |
| 여럿, 위쪽 줄에 전환기도 둔다 | 위와 같다 | 프로젝트 이름과 세션 전환 메뉴(DreamVerse의 `SessionSwitcher`) | 사이드바를 접어도 채팅을 바꿀 수 있다 | 같은 일을 하는 자리가 둘이다. 만들 것이 는다 |
| 하나 | 프로젝트 목록뿐 | 프로젝트 이름 | 가장 단순하다. 프로젝트와 대화가 1:1이다 | dsh의 새 세션·포크 길(단축키 등)을 내부 장치로 막아야 한다. 대화가 길어지면 압축에만 기댄다 |

## 고른 것

Claude가 고른 기본값이다. 사용자가 정하는 셋과 무관하게 서는 것만 적었다. 끝나면 `docs/DECISIONS.md` "전제"에 옮긴다.

| 무엇 | 고른 것 | 이유 | 뒤집으면 |
| --- | --- | --- | --- |
| 가운데의 두 모습 | 프로젝트가 열려 있지 않으면 **홈**(프로젝트 카드와 "새 프로젝트"), 열려 있으면 **프로젝트 틀**(위쪽 줄 + 화면 자리). 홈에는 채팅이 없다 | DreamVerse의 입구 채팅은 포크 전용 이벤트가 있어야 한다. 채팅은 늘 프로젝트 안에서, 우측 탭 한 곳에만 그린다(같은 세션의 대화를 두 곳에 그리지 않는다) | 홈에 입력창을 두려면 "프로젝트 없는 세션"을 어떻게 프로젝트로 만들지부터 정해야 한다 |
| 열린 프로젝트와 주 세션 | 주 세션이 어느 프로젝트의 세션이 되면 그 프로젝트가 열린다. 새로고침하면 dsh가 주 세션을 되살리고 열린 프로젝트가 따라온다. URL 해시에 위치를 적지 않는다 | dsh가 이미 주 세션을 저장한다. DreamVerse의 해시 미러와 복원(약 200줄)은 뒤로 가기를 위한 것이라 첫 목표에 필요 없다 | `store`에 해시 미러를 더한다(후속) |
| 프로젝트를 열 때 고르는 세션 | 주 세션이 이미 그 프로젝트의 것이면 그대로, 아니면 그 프로젝트의 가장 최근에 쓴(비어 있지 않은) 세션, 없으면 `uiWorkspace.openWorkspace`(빈 세션을 다시 쓰거나 만든다) | DreamVerse의 규칙에서 탭마다 빈 세션을 따로 두는 부분(여러 탭이 한 빈 세션을 같이 쓰는 문제)을 뺐다. 사용자가 한 명이다 | `actions`의 고르는 함수만 바꾼다 |
| 프로젝트를 열면 | 주 세션의 자리가 마운트되는 대로 우측 패널에 채팅 탭을 연다(세션마다 페이지 로드당 한 번). 홈으로 가면 우측 패널을 접는다 | DreamVerse와 같다. 사용자가 닫은 탭을 다시 열지 않는다 | — |
| 새 프로젝트 | 제목 "새 프로젝트"로 바로 만들고 연다(같은 제목이 있으면 API가 번호를 붙인다). 이름은 내비게이터에서 바꾼다 | 이름을 먼저 묻는 창이 없어도 된다. DreamVerse와 같다 | 만들기 전에 이름을 받는 입력을 홈에 둔다 |
| 프로젝트 빼기 | 확인을 받은 뒤 `/api/cs/projects/delete`. 목록에서 빠지고 폴더는 남는다는 것을 확인 문구에 적는다 | API의 동작 그대로다 | — |
| 화면이 꽂히는 자리 | `main.conversation`에 등록할 때 자식 슬롯 `cs.center.view`(list, root)를 선언한다. 화면 패키지가 여기에 등록하고, 틀이 `{ projectId, sessionId }`를 넘긴다. 등록된 화면이 없으면 안내 문구를 그린다 | DreamVerse의 `dv.center.view`와 같은 방식이다. 3-2의 갤러리가 셸을 고치지 않고 꽂힌다 | 슬롯 이름과 props는 `contract.ts` 한 곳에 있다 |
| 화면용 API 클라이언트 | `@cs/ui-shell` 안의 작은 모듈(`api.ts`, 프로젝트 라우트만) | 쓰는 곳이 하나다. 둘째 소비자가 생기는 3-2에서 `@cs/ui-kit`으로 옮긴다 | 패키지를 먼저 만든다 |
| 상태를 React 컴포넌트에 넘기는 길 | `apply`에서 저장소 하나를 만들고 등록의 `inject`가 돌려주는 `hooks`에 넣는다(`useShell(selector)`). 동작은 콜백 묶음으로 넘긴다 | 업스트림의 브라우저 코드 규칙이다(React 컴포넌트는 `ctx`를 보지 않고 직접 구독하지 않는다). DreamVerse는 모듈 변수와 `useSyncExternalStore`를 썼다 | — |
| 실패 알림 | 동작이 실패하면 `shell.overlay`에 dsh의 `Toast`로 문구를 띄운다 | DreamVerse와 같다 | — |
| 하지 않는 것 | 왼쪽 사이드바 자동 접기, 우측 패널의 기본 폭 바꾸기, Ctrl+Z 실행 취소 단축키, 테마 바꾸기, 표지 그림 | 앞의 둘은 dsh 내부에 기대는 장치다. 단축키와 표지는 연산과 에셋이 있는 화면이 생긴 뒤의 일이다(3-2) | 후속으로 더한다 |
| 채팅 탭 | 정의 id `@cs/ui-shell/chat`, kind `cs-chat`, 제목 "채팅", `keepMounted` | `docs/DSH.md` "채팅을 우측 탭으로 옮기는 코드"의 이름이다 | 상수만 바꾼다 |
| 에이전트 프리셋 | 주지 않는다(dsh 기본 프리셋 그대로) | 미정이다(1-4) | `openWorkspace`의 옵션에 프리셋을 준다 |

## 만들 것

전부 `packages/ui-shell/src/client/` 아래다. 호스트 절반(`src/index.ts`)은 그대로 빈 플러그인이다.

| 파일 | 내용 |
| --- | --- |
| `index.ts` | `inject`와 `apply`. 저장소·클라이언트·동작을 만들고 슬롯과 탭을 등록한다. `ctx`를 쓰는 곳은 이 파일과 `actions.ts`, `follow.ts`, `chrome.ts`뿐이다 |
| `contract.ts` | 타입만: 자식 슬롯 `cs.center.view`의 선언 병합, 셸 상태와 동작의 타입, 등록이 넘기는 얼굴(`ShellInjected`) |
| `store.ts` | 셸 상태 저장소(`getSnapshot`, `subscribe`, `set`). 상태는 `projects`(목록, 처음 읽기 전에는 `null`), `projectId`(열린 프로젝트, 홈이면 `null`), `sessionId`(가운데가 마지막으로 본 주 세션), `failure`(띄울 실패 문구) |
| `navigation.ts` | 순수 함수: 주 세션의 프로젝트를 따라 열린 프로젝트를 정하는 규칙, 프로젝트를 열 때 세션을 고르는 규칙, 프로젝트의 세션 목록을 만드는 규칙 |
| `api.ts` | `/api/cs/projects…`를 부르는 클라이언트와 오류 타입. 응답 타입은 `@cs/api/wire`에서 `import type`으로 가져온다 |
| `actions.ts` | `createActions(ctx, store, client)`: 새 프로젝트, 프로젝트 열기, 세션 열기, 새 채팅, 홈, 이름 바꾸기, 빼기, 채팅 탭 열기. 실패를 저장소에 적는 실행기 |
| `follow.ts` | `apply`에서 거는 구독: 작업공간 목록이 바뀌면 프로젝트 목록을 다시 읽는다(실패하면 2초 뒤 다시). 주 세션이 바뀌면 열린 프로젝트를 맞춘다. 자리가 마운트되면 채팅 탭을 연다 |
| `chrome.ts`, `chrome.module.css` | **dsh 내부에 기대는 장치를 모으는 한 곳.** 내용은 "사용자가 정할 것" 2에 달렸다 |
| `Navigator.tsx` | 슬롯 `sidebar.workspaces`: 홈, 프로젝트 목록(이름 바꾸기·빼기 메뉴), 세션 줄(3번 답에 따라) |
| `Center.tsx`, `Home.tsx`, `ProjectFrame.tsx` | 슬롯 `main.conversation`: 주 세션을 저장소에 알리고 홈이나 프로젝트 틀을 그린다 |
| `ChatTab.tsx` | 우측 패널 탭의 본문: Factory 슬롯 `conversation.content`를 채팅 뷰만으로 그린다 |
| `Brand.tsx`, `NewProjectButton.tsx`, `FailureToast.tsx` | 슬롯 `sidebar.brand.*`, `sidebar.session.action`, `shell.overlay` |
| `shell.module.css` | 우리 클래스의 스타일. dsh 색 토큰만 쓴다 |
| `strings.ts` | 한국어 문자열 전부 |

지우는 것: `BuildProbe.tsx`, `BuildProbe.module.css`, 그 등록과 문자열, `tests/integration/boot.test.ts`의 프로브 확인(셸 확인으로 바꾼다).

## 시험

- **단위 시험**(대상 옆): `store.test.ts`(알림은 값이 바뀔 때만, 스냅샷은 다음 변경까지 같은 참조), `navigation.test.ts`(주 세션을 따르는 규칙과 세션 고르기의 경우들), `api.test.ts`(경로·본문·오류 본문 `{error, code}`의 해석. `fetch`는 주입한 가짜다).
- **조합 시험**(`tests/integration/shell.test.ts`, 실제 dsh와 브라우저): 브랜드 이름이 보인다 → 홈의 빈 상태가 보인다 → "새 프로젝트"를 누르면 내비게이터와 가운데에 프로젝트가 생긴다 → 우측 패널에 채팅 탭이 열리고 입력창에 글이 쳐진다 → 이름을 바꾼다 → 홈으로 가면 카드가 보이고 다시 열린다 → 새로고침해도 같은 프로젝트가 열려 있다 → 프로젝트를 빼면 목록에서 사라지고 폴더는 남는다. 라이트와 다크에서 콘솔 오류·경고 0건. 기본 작업공간 토스트가 뜨지 않는다(2번 답이 "교체만"이 아니면).
- 메시지가 오가는 것은 모델 키가 있어야 해서 보지 못한다(1-3).

## 분담

`AGENTS.md` "구현 작업 분담"의 "대"다. 지휘 세션이 `contract.ts`, `strings.ts`, `index.ts`, `package.json`과 조합 시험·문서를 쓰고 통합한다.

| 묶음 | 파일 | 등급 |
| --- | --- | --- |
| 순수 로직 | `store.ts`, `navigation.ts`, `api.ts`와 그 단위 시험 | 표준 |
| dsh 서비스를 부르는 쪽 | `actions.ts`, `follow.ts`, `chrome.ts`, `chrome.module.css` | 상위(dsh 내부에 기대는 장치가 든다) |
| React 컴포넌트와 스타일 | `Navigator.tsx`, `Center.tsx`, `Home.tsx`, `ProjectFrame.tsx`, `ChatTab.tsx`, `Brand.tsx`, `NewProjectButton.tsx`, `FailureToast.tsx`, `shell.module.css` | 표준 |

## 완료 기준

`docs/ROADMAP.md` 3-0의 것이다: 프로젝트를 만들고 열 수 있고, 우측 탭의 입력창에 글을 쓸 수 있다. 콘솔 오류 0건, 라이트·다크 모두 확인. `pnpm check`와 `pnpm test:integration`이 통과한다.

## 결과

2026-11-28에 만들었다.

- `packages/ui-shell/src/client/`: `index.ts`(등록), `contract.ts`·`ids.ts`·`strings.ts`, `store.ts`, `navigation.ts`, `api.ts`, `host.ts`(dsh 서비스를 좁은 인터페이스 `ShellHost`로 감싼다), `actions.ts`, `follow.ts`, `views.ts`(자식 슬롯의 항목을 탭으로 읽는다), `chrome.ts`·`chrome.module.css`(dsh 내부에 기대는 장치 둘), React 컴포넌트 `Brand`, `NewProjectButton`, `Navigator`, `Center`, `Home`, `ProjectFrame`, `ChatTab`, `FailureToast`와 그 스타일.
- 등록한 자리: `sidebar.brand.name`·`sidebar.brand.mark`·`sidebar.workspaces`·`main.conversation`(`priority: -1`), `sidebar.session.action`(`hoc`), `shell.overlay`, 우측 탭 `cs-chat`과 `sidebar.right.pane.tab`. `main.conversation`의 등록이 자식 슬롯 `cs.center.view`를 선언한다.
- `packages/api`: `wire.ts`가 `@cs/project/types`만 가져오고, 연산 선언의 타입은 `wire-operation.ts`로 떼었다.
- 지운 것: `BuildProbe.tsx`, `BuildProbe.module.css`, `tests/integration/boot.test.ts`.
- 시험: 셸의 단위 시험 98개(저장소 전체 627개), 조합 시험 `tests/integration/shell.test.ts` 3개.
- **띄워 확인**(2026-11-28, 조합 시험): `docs/ROADMAP.md` 3-0의 "확인한 것"과 같다. 두 장치, 메뉴 가림, 채팅 요청은 일부러 망가뜨려 시험이 실패하는 것을 봤다. 자식 슬롯은 화면 둘을 임시로 등록해 띄워 봤고(순서대로 탭, 고른 화면만, 넘어온 `projectId`·`sessionId`가 맞다) 등록은 되돌렸다.
- **확인하지 못한 것**: 메시지가 오가는 것, 대화가 있는 세션이 여럿일 때의 목록과 전환(모델 키가 있어야 한다). 그 밖은 `docs/DSH.md` "확인하지 못한 것"에 있다.

### 계획과 달라진 것

- **dsh 서비스를 한 파일 뒤에 뒀다**(`host.ts`). 계획은 `actions.ts`와 `follow.ts`가 `ctx`를 직접 쓰는 것이었다. 좁은 인터페이스 뒤에 두니 두 파일의 단위 시험이 Cordis 없이 돈다. `ctx`를 쓰는 곳은 `index.ts`, `host.ts`, `views.ts`, `chrome.ts`이고 `actions.ts`·`follow.ts`의 `ctx` 받는 함수는 한 줄짜리다.
- **`views.ts`가 생겼다.** 자식 슬롯의 항목을 탭으로 읽는 일이 계획의 표에 없었다.
- **스타일은 한 파일이 아니라 React 컴포넌트마다 나눴다**(`Brand`, `Center`, `ChatTab`, `Navigator`, `NewProjectButton`의 `.module.css`). `shell.module.css`는 없다.
- **`@cs/api/wire`를 고쳤다.** 브라우저 프로그램에서 타입 검사가 되지 않았다(프로젝트 계층의 진입점이 Node 모듈을 끌어왔고, 연산 선언의 타입은 dsh의 호스트 선언을 끌어와 `ctx.sessions`의 타입을 덮었다). `docs/DSH.md` "타입을 얻는 패키지"에 적었다.
- **채팅 탭은 "세션마다 한 번"만으로는 모자랐다.** 우측 패널의 펼침이 세션마다 따로라서, 홈에서 접은 세션으로 돌아오면 접힌 채였다. 사용자가 프로젝트나 채팅을 열 때마다 요청을 올리고, 그 세션의 자리가 마운트된 뒤에 탭을 연다.
- **새 세션 버튼은 CSS로 숨기지 않았다.** 0.2.2-rc.5에는 `hoc` 슬롯 `sidebar.session.action`이 있다.
- 조합 시험이 계획보다 더 본다: dsh 페이지에서 돌아오기, 채팅 목록 접기, 브랜드 누르기, 화면용 API의 거절과 실패 알림.

### 리뷰에서 나온 것

구현과 독립된 리뷰(상위 등급)를 한 번 받았다. diff와 이 문서만 주고 구현자의 결론은 주지 않았다. P1은 없었다.

| 지적 | 처리 |
| --- | --- |
| P2 채팅 탭이 이미 열렸던 세션으로 다른 프로젝트를 거쳐 돌아오면 패널이 접힌 채다 | 고쳤다(위 "채팅 탭은…"). 단위 시험과 조합 시험을 더했고, 망가뜨리면 조합 시험이 실패한다 |
| P3 프로젝트 열기가 실패하면 가운데는 새 프로젝트, 우측은 앞 프로젝트의 채팅이다 | 실패하면 가운데를 주 세션의 프로젝트로 되돌린다. 시험을 더했다. dsh가 스스로 띄우는 알림과 우리 알림이 같이 뜨는 것은 그대로 둔다(어느 실패에 dsh가 알림을 띄우는지에 기대게 된다) |
| P3 주 세션이 그 프로젝트의 빈 세션이면 다른 세션으로 옮긴다(계획과 다르다) | 계획대로 고쳤다: 그 프로젝트의 주 세션은 비어 있어도 그대로 둔다 |
| P3 열린 프로젝트의 채팅 목록을 접을 수 없다 | 고쳤다. 조합 시험이 본다 |
| P3 "새 프로젝트"를 두 번 누르면 둘이 생긴다 | 만드는 동안의 둘째 누름을 무시한다. 시험을 더했다 |
| P3 조합 시험의 "새 세션 버튼이 없다" 단언이 실패할 수 없다(이름의 대소문자) | 슬롯 안에 우리 버튼 하나뿐인지를 본다 |
| P3 브랜드 누르기 확인이 시간에 기댄다 | 계산된 `pointer-events`도 본다 |
| P3 홈에서 우측 패널을 다시 펼치면 직전 채팅이 보인다 | 그대로 둔다. 막으려면 장치가 하나 더 들고 사용자가 고른 "최소"의 밖이다. `docs/ROADMAP.md` 3-0 "후속"과 `docs/DSH.md` "확인하지 못한 것"에 적었다 |
| P3 주 세션이 없으면 "채팅 열기"가 아무 일도 하지 않는다 | 자리가 없으면 열린 프로젝트에 다시 들어간다. 시험을 더했다 |
| P3 플러그인이 내려간 뒤에도 기다리던 이동이 dsh 서비스를 부를 수 있다 | 동작에 `dispose`를 두고 플러그인이 내려갈 때 부른다. 시험을 더했다 |
| P3 기본 작업공간 장치가 `apply` 순서에 기댄다 | `chrome.ts`의 다시 볼 것에 적었다(첫 실행은 호스트의 두 목록이 온 뒤에 돈다) |
| P3 영어 문구가 알림에 나올 수 있다 | API 클라이언트의 두 문구를 `strings.ts`로 옮겼다. 서버가 준 오류 문구는 그대로 보인다(영어다. 1-6에서 같이 본다) |
| P3 채팅 탭의 단계 계산에 `engaging`이 빠졌다 | 업스트림의 계산대로 고쳤다(보내기를 시도한 세션은 입력창을 숨기지 않는다) |
| P3 화면 탭의 이름표를 한 번만 푼다 | 이름표를 그대로 넘기고 그릴 때마다 푼다 |
| P3 주석과 문서가 `host.ts`·`views.ts`를 빼먹었다 | 고쳤다 |

### 남긴 것

`docs/ROADMAP.md` 3-0의 "미확인"과 "후속"에 있다.
