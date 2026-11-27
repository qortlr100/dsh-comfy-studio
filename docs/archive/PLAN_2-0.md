# 단계 계획 — 2-0 프로젝트 계층 이식

`docs/ROADMAP.md` 2-0의 상세 계획이다. 브랜치는 `2-0-project-layer`다(2026-11-27). 끝났다: 결과는 맨 아래 "한 것"부터 읽는다.

## 범위

DreamVerse `@dv/project`(커밋 `ec0ac62760`)를 이 저장소의 패키지 `@cs/project`로 옮기고 dsh 0.2.2-rc.5에서 실제로 돌린다.

- 소스 14개 파일 4,612줄과 시험 3,554줄(시험 12개, 시험 지원 2개, 시험용 플러그인 1개)을 옮긴다.
- dsh 0.2.2-rc.5와 어긋나는 곳을 고친다(`docs/DREAMVERSE.md` "dsh 0.2.2-rc.5와의 차이"의 5건과, 돌려 보며 나오는 것).
- 번들에 행을 넣고, 1-2의 호스트 쪽 조합 시험으로 완료 기준을 확인한다.
- 가져온 코드의 고지를 `THIRD_PARTY_NOTICES.md`에 적는다.

범위 밖: 화면용 API(2-2), 에셋 저장소와 기능 컴포넌트(2-3), 프로젝트를 만드는 화면(3-0), 에이전트 프리셋(1-4), 실제 모델로 하는 확인(1-3. 모델 키가 없다).

## 옮기는 것

DreamVerse `packages/dv/project/`의 모듈이다. 서비스 하나(`src/index.ts`)가 나머지 열두 모듈에 일을 넘긴다.

| 모듈 | 줄 | 하는 일 | dsh에 닿는 곳 |
| --- | --- | --- | --- |
| `index.ts` | 632 | 서비스(Cordis `Service`). 공개 메서드, 도구·프롬프트 절·프로젝션 등록 | `workspaceRegistry`, `tools`, `systemPrompt`, `sessionProjections`, `sessions`, `sessionPersistence` |
| `types.ts`, `operation-types.ts` | 478, 119 | 기록·연산·리듀서·상태의 타입 | 타입만 |
| `record-store.ts` | 408 | `records.jsonl`과 `line.json`을 읽고 쓰는 유일한 코드, 프로젝트 잠금 | 없음 |
| `runner.ts` | 516 | 연산 실행(검증 → 잠금 안에서 기록 → 잠금 밖에서 실행 → 갱신 줄), 재사용, 재시작 뒤 정리 | 없음 |
| `scheduler.ts` | 243 | 끝나지 않은 기록을 기다리는 호출, cpu·gpu 동시 실행 수 | 없음 |
| `history.ts` | 122 | 실행 취소, 다시 실행, 단계로 이동, 기록 목록 조회 | 없음 |
| `reducers.ts` | 398 | 리듀서 등록, 상태 계산, 참조 종류(버전), 에이전트용 요약 | 없음 |
| `folders.ts`, `folder.ts` | 134, 20 | 프로젝트 = 기록 디렉터리가 있는 dsh 작업공간. 새 폴더, 만들기, 이름 바꾸기, 빼기 | `WorkspaceRegistry` |
| `agent-tools.ts` | 470 | 연산 하나를 에이전트 도구 하나로 | `defineTool`, 첨부, 턴 번호 |
| `proj-tools.ts` | 367 | 프로젝트 도구 여덟 개(`…proj_create`, `_rename`, `_state`, `_history_list`, `_undo`, `_redo`, `_stale_accept`, `_wait`) | `defineTool` |
| `agent-context.ts` | 49 | 시스템 프롬프트의 프로젝트 규칙 절 | 없음(서비스가 등록한다) |
| `project-updates.ts` | 292 | 프로젝트 상태 메시지와 갱신 메시지, "에이전트가 무엇을 봤는지"의 세션 프로젝션 | `agent/pre-step`, `sessionProjections`, `createUserMessage` |
| `grammar.ts`, `citations.ts` | 196, 34 | 입력 참조와 프롬프트 인용(`@[이름](…:<종류>/<id>)`)의 문법 | 없음 |
| `subscriptions.ts`, `sessions.ts`, `shared.ts` | 57, 34, 43 | 변경 구독, 세션별 도구 호출 보류, 오류 클래스 | 없음 |

## 사용자가 정한 것

`docs/DECISIONS.md` "미정"이고 로드맵 2-0의 "정할 것"이었다. 2026-11-27에 아래 안을 보이고 사용자가 골랐다. 구현은 그 뒤에 시작했다.

| 무엇 | 고른 답 |
| --- | --- |
| 이름(기록 디렉터리, 도구 접두사, 서비스 이름) | cs 계열: `.comfy-studio/`, `cs_`, `ctx.csProject` |
| 영상 전용 용어를 어디까지 걷어낼지 | 글과 `surface`만 |
| 새 프로젝트의 폴더 | 홈 폴더 아래: `<사용자 홈>/comfy-studio-projects/<이름>` |
| Claude가 고른 나머지 기본값("고른 것") | 그대로 진행 |

아래 세 절은 그때 보인 안이다. 안을 만들 때 쓴 사실은 DreamVerse 소스와 설치된 dsh 0.2.2-rc.5 패키지에서 읽었다(**소스 확인**, 2026-11-27).

### 1. 이름: 기록 디렉터리, 도구 접두사, 서비스 이름

DreamVerse는 `.dreamverse/`, `dv_`, `dvProject`다. 소스에서 이 이름들이 쓰인 곳은 약 180군데이고 전부 기계적으로 바뀐다.

| 안 | 기록 디렉터리 | 도구 | 서비스 |
| --- | --- | --- | --- |
| **cs 계열(권함)** | `<프로젝트 폴더>/.comfy-studio/` | `cs_proj_create`, `cs_<연산>` | `ctx.csProject` |
| comfy 계열 | `<프로젝트 폴더>/.comfy-studio/` | `comfy_proj_create`, `comfy_<연산>` | `ctx.comfyProject` |
| studio 계열 | `<프로젝트 폴더>/.studio/` | `studio_proj_create`, `studio_<연산>` | `ctx.studioProject` |

- 권하는 이유: 패키지 스코프(`@cs/*`)와 같아 코드에서 한 가지 접두사만 쓴다. 도구 이름은 요청마다 모델에게 가므로 짧은 쪽이 낫다. `comfy_`는 ComfyUI 자체의 것(노드, 서버 API)과 헷갈린다. 디렉터리는 사용자가 디스크에서 보는 이름이라 줄이지 않고 프로필 이름(`comfy-studio`)과 맞춘다.
- 접두사를 따라 같이 바뀌는 이름(cs 계열일 때): 프롬프트 절 `cs:project`, 인용 주소 `cs:<종류>/<id>`, 세션 프로젝션 `csProjectSight`, 도구 결과의 메타 키 `cs_seen`, 메시지 출처 종류 `cs-project`, 브랜드 타입 `CsAssetId`·`CsProjectId`·`CsRecordId`·`CsSessionId`·`CsTurnId`, 설정을 가리키는 환경 변수 이름 `CS_PROJECTS_FOLDER`.
- 화면에 쓸 제품 이름은 3-0의 미정이다. 에이전트가 읽는 글에는 제품 이름을 넣지 않는다("DreamVerse project state." → "Project state.").

### 2. 영상 전용 용어를 어디까지 걷어낼지

`@dv/project`는 도메인과 무관한 틀이다. 영상 낱말은 타입 한 곳, 에이전트가 읽는 글 세 곳, 그리고 주석·예시에 있다(낱말 기준 약 70군데).

| 안 | 바꾸는 것 | 그대로 두는 것 |
| --- | --- | --- |
| **글과 `Surface`만(권함)** | 에이전트가 읽는 글(도구 설명의 "video project", 프롬프트 절의 "Render one again", 갱신 메시지의 "user on canvas"), 기록의 `surface` 값, 주석과 예시의 영상 낱말(`timeline.clip_move`, take, shot) | 구조 전부: 기록 형식, 실행 흐름, `supersedes`·`based_on`·stale, `pendingInputRoles`, `started_by`, `outsideHistory`, 참조 종류(버전) |
| 에이전트가 읽는 글만 | 에이전트가 읽는 글 | 주석·예시·`Surface`까지 원문 그대로(DreamVerse와의 diff가 작아 나중에 고친 것을 받아 오기 쉽다. 대신 `canvas`·`timeline`이 기록에 남는다) |
| 장치까지 | 위에 더해 영상 제작에서 온 장치(`pendingInputRoles`, `started_by`의 lane)를 지운다 | — (시험 다수를 다시 써야 하고, 배치 생성에서 다시 필요해질 수 있다) |

- `surface`는 기록 파일에 남는 값이다. 지금은 `chat`, `canvas`, `timeline`, `asset_pool`, `api`, `history`다. 권하는 안에서는 `chat`, `view`, `api`, `history`로 둔다. `view`는 우리 화면(가운데 화면과 우리 탭)에서 한 사용자 동작이다. 화면별로 나눌지는 화면을 만드는 단계(3-2 이후)에서 정한다.
- 출력 종류의 `video`·`audio`는 영상 전용이 아니다(ComfyUI도 영상·오디오를 낸다). 어느 안에서도 그대로 둔다.

### 3. 새 프로젝트의 폴더를 어디에 만들지

DreamVerse는 `<문서 폴더>/deepseek-harness/DreamVerse/<이름>`에 만든다. 문서 폴더는 dsh의 `defaultWorkspaceDirectory`가 OS에 물어 얻는데(Linux는 `xdg-user-dir DOCUMENTS`), 0.2.2-rc.5에서는 그 함수가 공개 진입점으로 나오지 않고 마지막 폴더 이름도 고정(`default-workspace`)이다. 문서 폴더가 없는 호스트(XDG 사용자 폴더를 두지 않은 Linux 등)에서는 던진다. 임시 home으로 띄울 때 뜨는 "Unable to create default workspace" 토스트가 같은 원인으로 보인다(추정).

어느 안이든 플러그인 설정 `projectsFolder`(절대 경로)가 있으면 그것을 쓴다. 아래는 설정이 없을 때의 기본값이다.

| 안 | 기본 위치 | 장점 | 단점 |
| --- | --- | --- | --- |
| **홈 폴더 아래(권함)** | `<사용자 홈>/comfy-studio-projects/<이름>` | 어느 호스트에서나 정해진다. 사용자가 파일로 볼 수 있다. dsh home을 지워도 프로젝트 파일은 남는다 | 홈 폴더에 폴더 하나가 생긴다 |
| dsh home 아래 | `$DSH_HOME/comfy-studio/projects/<이름>` | home 하나만 백업하면 된다. 개발용 home(`.dsh-home`)과 실제 home의 프로젝트가 섞이지 않는다 | 숨은 폴더 안이다. home을 지우거나 저장소에서 `git clean -x`를 하면 생성물이 같이 사라진다 |
| dsh와 같은 규칙 | `<문서 폴더>/deepseek-harness/comfy-studio/<이름>` | dsh 기본 작업공간 옆에 놓인다 | 문서 폴더가 없는 호스트에서는 서비스가 뜨지 않아 설정이 필수다. 공개되지 않은 dsh 함수를 베껴 와야 한다 |

- 권하는 이유: 프로젝트 폴더에는 다시 만들 수 없는 생성물이 들어간다. dsh의 상태(프로필, 세션)와 떨어져 있어야 home을 초기화할 때 같이 잃지 않는다. 조합 시험은 `HOME`도 임시 폴더로 주므로(`docs/DSH.md` "띄워서 확인하는 법") 시험이 실제 홈 폴더에 쓰지 않는다.
- 프로젝트 목록은 dsh 작업공간 등록부(home 안)에 있다. home을 지우면 폴더는 남고 등록만 사라진다. 그 폴더를 다시 프로젝트로 더하면 기록이 그대로 읽힌다(프로젝트 id는 새로 붙는다).

## 고른 것

Claude가 고른 기본값이다. 위 셋과 함께 사용자에게 보였고 사용자가 "그대로 진행"을 골랐다(`docs/DECISIONS.md` "확정").

| 무엇 | 고른 것 | 이유 | 뒤집으면 |
| --- | --- | --- | --- |
| 패키지 | `packages/project`, `@cs/project`. 호스트 절반만 있다. 번들 행 id는 `cs-project` | `docs/ARCHITECTURE.md` "패키지 구성(가칭)"의 이름이다 | 이름만 바꾼다 |
| 코드 모양 | 이 저장소의 규칙으로 다시 맞춘다: Prettier(세미콜론, 큰따옴표, 폭 100), 지울 수 있는 문법만(생성자 매개변수 속성을 필드 선언으로 푼다. 소스 9곳과 시험 3곳이었다) | 호스트 절반은 Node가 `.ts`를 바로 실행한다(`docs/DSH.md` "플러그인 패키지 하나의 모양"). 포맷 검사가 `pnpm check`에 들어 있다 | DreamVerse와의 줄 단위 diff는 포기한다. 고친 것을 받아 올 때는 모듈 단위로 읽어 옮긴다 |
| 시험의 자리 | `tests/x.spec.ts` → `src/x.test.ts`(대상 옆). 시험 지원과 시험용 플러그인은 `src/testing/`에 둔다 | 1-2에서 정한 자리다(`pnpm test`가 `packages/*/src/**/*.test.ts`를 돈다) | Vitest 설정의 `include`를 바꾼다 |
| dsh 패키지 의존 | 값으로 쓰는 dsh 패키지를 `dependencies`에 `0.2.2-rc.5`로 고정한다. `@deepseek-ai/cordis` 4.1.0과 `@deepseek-ai/schemastery` 3.19.0은 `peerDependencies`와 `devDependencies`에 둔다 | DreamVerse의 구성이다. Cordis는 dsh가 실은 것과 같은 모듈이어야 서비스가 걸린다 | 띄워 봐서 모듈이 둘로 갈리면 구성을 고친다(아래 "확인할 위험") |
| 에셋 저장소가 없을 때 | 서비스가 **빈 저장소**로 대신한다(`has`는 거짓, 나머지는 `unknown_asset`으로 던진다). DreamVerse는 요약을 만들 때도 던진다 | 에셋 기능 컴포넌트는 2-3에서 온다. 그때까지 프로젝트 요약 도구와 상태 메시지가 "No asset store"로 죽으면 프로젝트에 묶인 채팅의 모든 단계가 실패한다. 에셋이 없으면 출력도 없으므로 요약은 그대로 맞다 | 2-3에서 에셋 저장소가 등록되면 쓰이지 않는 길이다. 지워도 된다 |
| 연산의 `label` | `{ zh, en }` → `string`(화면에 보일 한국어 이름) | 우리 화면의 문자열은 한국어다(`AGENTS.md`). 프로젝트 계층은 저장만 한다 | 1-6에서 로케일 사전으로 옮기면 타입을 다시 바꾼다 |
| 설정 | `projectsFolder`, `cpuConcurrency`(4), `gpuConcurrency`(1), `promptSectionOrder`(4900)를 그대로 둔다 | 바꿀 이유가 없다 | 설정 스키마를 고친다 |
| 번들 | `@cs/bundle`에 `cs-project` 행을 넣는다. 설정은 비운다(기본값) | 프로필을 띄우면 서비스가 올라와야 완료 기준을 본다 | 행에 `disabled: true`를 준다 |
| 조합 시험용 연산 | 시나리오 모듈이 등록한다(`note.add` 같은 시험용 기능 컴포넌트). 패키지에는 시험용 연산을 넣지 않는다 | 패키지는 도메인과 무관한 틀로 둔다 | — |
| 패키지 문서 | `CONTRACTS.md`(모듈마다의 함수·규칙·오류·시험 목록, 352줄)를 이름을 바꿔 `packages/project/`에 옮긴다. `README.md`는 옮기지 않고 쓰는 법을 `docs/ARCHITECTURE.md`에 한국어로 적는다 | 모듈 계약은 구현과 함께 있어야 한다. README의 토큰 수치와 영상 예시는 우리 것이 아니다 | — |
| 프로젝트 규칙 절의 내용 | 뜻을 바꾸지 않고 옮긴다("모든 호출은 바로 히스토리의 단계다. 사용자가 변경을 승인하지 않는다" 포함) | 프로젝트 계층의 규칙이다. 기존 앱의 "제안 후 승인"(삭제, 그래프 패치)은 연산을 어떻게 나누는지의 문제라 2-3에서 다룬다 | 2-3에서 절의 문장을 고친다 |

## dsh 0.2.2-rc.5에 맞추는 곳

| 위치(DreamVerse) | 지금 | 고치는 법 |
| --- | --- | --- |
| `index.ts:45`, `:226` | `defaultWorkspaceDirectory('DreamVerse', undefined, signal)` — 포크가 더한 export | "정할 것 3"의 답대로 폴더를 정한다. 그 import를 지운다(`@deepseek-ai/dsh-api-workspace-controller` 의존도 빠진다) |
| `project-updates.ts:149` | `ProjectionDefinition<'dvProjectSight'>` | `ProjectionDefinition<K, S>` 두 인자로 |
| `project-updates.ts:280`~`:287` | `ctx.sessionProjections.register(def)` 뒤 `ctx.sessionProjections.stateOf(session, key)` | `register`가 `Promise<ProjectionHandle<S>>`를 준다. 기다려 받은 핸들의 `handle.stateOf(session)`을 쓴다. `SessionProjectionStateMap` 선언 병합은 지운다(0.2.2-rc.5에 없다) |
| `agent-tools.ts:163` | `sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn` | `ctx.get('agents')?.turnBoundaryOf(session).lastTurn`(0.2.2-rc.5의 `AgentRegistry`가 준다) |

타입이 맞는 것과 도는 것은 다르다(`docs/DREAMVERSE.md` "한계"). 옮긴 단위 시험 가운데 `agent-tools`, `proj-tools`, `project-updates`, 시험용 플러그인 시험은 실제 Cordis `Context`와 dsh의 `tools`·`systemPrompt` 서비스를 올려 돈다. 이것이 0.2.2-rc.5에서 처음 실행하는 자리다.

## 확인할 위험

- **Cordis 모듈이 둘로 갈리는지.** `@cs/project`는 `Service`를 값으로 가져온다. dsh가 실은 Cordis와 다른 사본이면 서비스 등록이 어긋날 수 있다. 조합 시험에서 `ctx.csProject`가 잡히는지로 본다.
- **호스트 시나리오가 `@cs/project`를 import하면 dsh가 실은 것과 같은 모듈인지**(`docs/DSH.md` "호스트 쪽 서비스를 부르는 시험"의 미확인 항목). 시나리오는 타입만 가져오고 서비스는 `ctx`로 받는 것을 기본으로 한다.
- **프리셋 밖에서 `tools` 서비스에 등록한 도구가 에이전트에게 보이는지.** 레지스트리에 등록되는 것까지는 조합 시험으로 본다. 에이전트의 도구 목록에 실제로 들어가는지는 모델 키가 있어야 하므로 미확인으로 남긴다(1-3).

## 조합 시험

`tests/integration/project.test.ts`와 시나리오 `tests/integration/scenarios/project-lifecycle.ts`. 시나리오는 dsh 프로세스 안에서 돈다.

1. `ctx.csProject`와 `ctx.tools`를 받는다.
2. 시험용 기능 컴포넌트를 등록한다: 열쇠 `note`, 리듀서(끝난 `note.add` 기록의 글을 모은다), 연산 `note.add`.
3. 임시 폴더를 프로젝트로 만든다(`createProject`). `<폴더>/<기록 디렉터리>/records.jsonl`에 첫 줄이 생긴다.
4. `run`으로 `note.add`를 두 번 실행한다. 기록 파일의 줄이 늘고(기록 줄 + 갱신 줄), `getState`의 `note` 조각에 글 둘이 보인다.
5. `undo` → 글 하나, `redo` → 글 둘. 기록 파일의 줄 수는 그대로다(이동은 기록을 쓰지 않는다).
6. `ctx.tools.definitions()`에 `<접두사>note_add`와 프로젝트 도구 여덟 개가 있다.
7. `newProjectFolder`가 "정할 것 3"의 위치에 폴더를 만든다(시험의 `HOME`은 임시 폴더다).

## 완료 기준

- 옮긴 단위 시험이 `pnpm test`로 통과한다. 뺀 시험이 있으면 이유와 함께 적는다.
- 위 조합 시험이 `pnpm test:integration`으로 통과한다.
- `pnpm check`가 통과한다.
- `pnpm -s dsh:config`에 `cs-project` 행이 보인다.

## 하는 순서와 분담

지휘 세션이 이름과 계약을 정하고 통합한다. 커밋은 아래 묶음마다 하나다.

| 묶음 | 내용 | 맡는 쪽 |
| --- | --- | --- |
| A | 패키지 틀(`package.json`, `tsconfig.json`), 소스와 시험을 복사해 이름 바꾸기·문법 풀기·포맷을 스크립트로 적용, dsh에 맞추는 네 곳 | 지휘 세션(기계적 변환은 스크립트로 해야 빠짐이 없다. dsh에 닿는 곳은 지휘가 직접 본다) |
| B | 영상 용어 고치기("정할 것 2"의 답대로), `CONTRACTS.md` | 표준 서브 에이전트 하나 |
| C | 번들 행, 조합 시험과 시나리오 | 지휘 세션 |
| D | 구현과 독립된 리뷰(diff와 이 문서만 준다) | 상위 서브 에이전트 하나 |
| E | 문서: `THIRD_PARTY_NOTICES.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/DSH.md`, `docs/DREAMVERSE.md`, `docs/ROADMAP.md`, `AGENTS.md` | 지휘 세션 |

## 한 것

커밋은 묶음마다 하나다.

| 묶음 | 한 것 |
| --- | --- |
| A, C | `packages/project`를 만들고 소스와 시험을 스크립트로 복사해 이름을 바꿨다(34개 파일과 `CONTRACTS.md`). 생성자 매개변수 속성 12곳을 필드 선언으로 풀었다. dsh에 맞추는 네 곳과 새 프로젝트 폴더, 빈 에셋 저장소를 고쳤다. 번들에 `cs-project` 행을 넣고 조합 시험을 썼다. `THIRD_PARTY_NOTICES.md`를 만들었다 |
| B | 영상 용어를 걷어냈다: 에이전트가 읽는 글, `surface`, `label`, 주석과 예시, 시험의 가짜 연산·컴포넌트 이름(`shot.render` → `image.generate`, `timeline` → `batch`, `take` → `variant`, `clip` → `item` 등 한 가지 대응), `CONTRACTS.md` |
| 린트 | 옮긴 코드가 이 저장소의 린트(타입 기반 규칙 포함)를 통과하게 고쳤다(아래 "계획과 달라진 점") |
| E | 문서 |

## 계획과 달라진 점

- **dsh와의 차이가 하나 더 있었다.** 도구 실행 API다. 0.2.2-rc.5의 `tools.execute`는 호출 하나가 아니라 묶음(`calls`)을 받고, 실행기를 플러그인(`@deepseek-ai/dsh-tool-executor-native`)이 준다. 소스는 도구를 정의만 하므로 고칠 것이 없었고, 시험의 호출부 네 곳을 공용 도우미(`src/testing/workspaces.ts`의 `mountTools`·`callTool`)로 바꿨다. 그 실행기를 `@cs/project`의 `devDependencies`에 더했다.
- **시험의 서비스 흉내도 바꿨다.** 턴 번호를 주던 가짜 `sessionProjections`는 가짜 `agents`(`turnBoundaryOf`)가 됐다.
- **기본 폴더를 보는 시험은 다시 썼다.** 문서 폴더 규칙을 흉내 내던 시험을 홈 폴더 규칙의 시험으로 바꿨다(`src/folders.test.ts`). 시험 수는 113개 그대로다.
- **린트.** 옮긴 코드는 이 저장소의 린트에서 109건이 걸렸다(타입 단언 59건, 제자리 정렬 15건 등). 소스의 것은 동작이 같은 형태로 고쳤고(`toSorted`, 의미 없는 `void` 제거, 좁히기), 타입 단언 가운데 고칠 수 없는 12곳은 이유를 적고 그 줄에서만 규칙을 껐다(자기가 쓴 파일을 읽는 곳, 도구 레지스트리가 스키마로 검증한 값 등). 시험의 타입 단언은 `src/testing/support.ts`의 도우미 셋으로 모았다: `defined`(없으면 던진다), `instanceof`로 좁히기, `standIn`(dsh API에 넘기는 가짜와 시험이 만든 JSON의 모양. 단언은 이 한 곳에만 있다). 린트 설정(`.oxlintrc.json`)은 바꾸지 않았다.
- **조합 시험이 하나 늘었다.** `CS_PROJECTS_FOLDER`가 번들의 행을 거쳐 서비스에 닿는지를 본다. 그러려고 `runHostScenario`에 `env` 옵션을 더했다.
- **루트 `devDependencies`에 셋을 더했다**: `@cs/project`(시나리오가 타입과 값을 가져온다), `@deepseek-ai/dsh-session`·`@deepseek-ai/dsh-session-projection`(시나리오의 `ctx.sessions`·`ctx.sessionProjections` 타입).

## 확인한 것

2026-11-27, 이 브랜치에서 돌렸다.

- `pnpm check`의 검사(빌드, 타입, 린트, 포맷, 단위 시험 139개 가운데 프로젝트 계층 116개: 옮긴 113개와 새로 쓴 3개)가 통과한다.
- `pnpm test:integration`의 시험 8개가 통과한다. 프로젝트 계층의 둘(`tests/integration/project.test.ts`)이 실제 dsh 안에서 본 것:
  - 번들의 행으로 서비스가 올라오고 시나리오가 `inject: ["csProject"]`로 받는다.
  - 폴더를 프로젝트로 만들면 dsh 작업공간 등록부에 생기고 `.comfy-studio/records.jsonl`의 첫 줄이 `proj.create`다.
  - 시험용 연산을 두 번 실행하면 기록 줄이 늘고 리듀서의 상태에 둘 다 보인다. 실행 취소하면 하나, 다시 실행하면 둘이고 그 사이 기록 파일의 줄 수는 그대로다.
  - 연산의 도구(`cs_probe_note_add`)와 프로젝트 도구 여덟 개가 dsh의 도구 레지스트리에 있다.
  - 작업 폴더가 그 폴더인 채팅 세션의 프로젝트가 그 프로젝트다. `csProjectSight` 프로젝션이 등록돼 있고 새 세션의 초기 상태를 준다.
  - 시나리오가 값으로 가져온 `@cs/project`가 dsh가 실은 것과 같은 모듈이다.
  - 새 프로젝트 폴더는 dsh 프로세스의 홈(시험에서는 임시 폴더) 아래 `comfy-studio-projects/`에 생기고, `CS_PROJECTS_FOLDER`를 주면 그 폴더에 생긴다.
- `pnpm -s dsh:config`의 `# == @cs/bundle` 아래에 `cs-project` 행이 보인다.

## 리뷰

구현과 독립된 리뷰를 상위 모델에게 맡겼다(이식 커밋과 이 문서, 원본 소스, 설치된 dsh 0.2.2-rc.5의 타입 선언만 줬다). 원본을 같은 Prettier 설정으로 맞춰 모듈마다 비교한 결과 **소스의 동작 차이는 계획한 것뿐**이었다(매개변수 속성 풀기, `toSorted`·`toReversed`, 비교 함수, `EEXIST` 좁히기, 이름 바꾸기, dsh에 맞춘 네 곳, 빈 에셋 저장소). P1·P2는 없었고 P3 다섯 건을 이렇게 처리했다.

| 지적 | 처리 |
| --- | --- |
| 에이전트가 읽는 글에 제품 이름이 남아 있다(이식 커밋 시점) | 용어를 걷어낸 커밋에서 고쳤다 |
| 고지 파일이 그 커밋에 없는 변경(`label`, `surface`)을 적었다 | 같은 브랜치의 뒤 커밋에서 맞춰졌다 |
| Node의 `homedir()`가 던지면 `CS_PROJECTS_FOLDER`를 알려 주는 오류가 나오지 않는다 | `try`/`catch`로 감싸 같은 안내 오류를 던지게 했다. 시험에 그 경우를 더했다 |
| `CS_PROJECTS_FOLDER`가 빈 문자열이면 서비스가 뜨지 않는다 | 번들의 행을 `… \|\| undefined`로 바꿔 빈 값을 없는 것으로 본다. 조합 시험에 그 경우를 더했다 |
| 고친 `agent/pre-step` 리스너를 도는 시험이 없다(원본에도 없었다) | 단위 시험 셋을 새로 썼다(`src/project-updates-listener.test.ts`): 묶인 세션의 단계에 상태 메시지가 붙는다, 프로젝트가 없는 세션은 그대로다, 레지스트리가 프로젝션을 거절하면 그대로다 |

확인하지 못한 것(모델 키가 있어야 한다. 1-3): 연산 도구가 에이전트의 도구 목록에 들어가는지, 프로젝트 상태·갱신 메시지가 실제 턴에 붙는지, 턴 번호가 기록에 남는지, 이미지 출력이 첨부로 모델에게 가는지.

PR의 리뷰 봇(Codex)은 P2 두 건을 냈다. 둘 다 옮긴 원본의 규칙에 대한 것이고 코드와 맞는 지적이라 고쳤다(`AGENTS.md` "PR 리뷰 봇 지적 대응 기준": 실제 호출 경로가 재현되는 P2). **원본과 동작이 달라진 곳이다.**

| 지적 | 처리 |
| --- | --- |
| 결정적 연산의 재사용 열쇠가 에셋 id를 정렬한 목록이라 역할과 순서를 잃는다. 같은 에셋을 역할만 바꿔 부르면(`image=A, mask=B` 뒤 `image=B, mask=A`) 실행하지 않고 앞 결과를 돌려준다 | 열쇠를 역할별 목록으로 바꿨다(`runner.ts`의 `resolvedAssetsKey`): 역할은 정렬해 비교하고 역할 안의 순서는 지킨다. 재사용이 줄어드는 쪽이라 틀린 결과를 내지 않는다. 시험 하나를 더했다 |
| stale 계산이 입력의 생산자를 `created_by[에셋]`으로만 찾는다. 같은 에셋을 낸 기록이 뒤에 또 있으면(결정적 재사용이 그렇다) `<기록>#<출력>`으로 가리킨 기록을 대체해도 소비자가 stale이 되지 않는다 | `<기록>#<출력>` 입력은 가리킨 기록도 생산자로 본다(`reducers.ts`의 `producersOf`). 에셋 id로 가리킨 입력의 규칙은 그대로다. 시험 하나를 더했다 |

재리뷰에서 나온 P2 한 건은 고치지 않고 이유를 답글로 남겼다.

| 지적 | 거절한 이유 |
| --- | --- |
| 실행 중인 기록이 중지되거나 버려져도(실행 취소 뒤 새 쓰기) 연산이 던지지 않고 끝나면 `done`으로 기록된다 | 의도한 규칙이다. 중지는 연산이 신호를 보고 스스로 던지는 협조 방식이다(`CONTRACTS.md` 실행기 5번). 연산이 마쳤다면 출력이 이미 에셋으로 저장돼 있어 기록만 `cancelled`로 바꾸면 끝난 결과를 버린다. 취소의 결과가 셋(`canceled`, `running`, `finished`)이라는 기존 규칙과도 맞다. 버려진 단계는 히스토리 목록 밖이라 상태에 들어가지 않는다. 멈춰야 하는 연산(생성 실행, 4-2)은 신호를 보고 던지게 만든다 |

고친 두 규칙은 `packages/project/CONTRACTS.md`와 `THIRD_PARTY_NOTICES.md`에 적었다. 단위 시험은 141개(프로젝트 계층 118개: 옮긴 113개와 새로 쓴 5개)다.

