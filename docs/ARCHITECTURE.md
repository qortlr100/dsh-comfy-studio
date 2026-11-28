# 아키텍처

만들 구조를 적는다. 만들어진 것은 프로젝트 계층(2-0, 2026-11-27. 제안 장치는 2-3a), 화면용 API(2-2), 카탈로그 계약(2-1), 셸(3-0), 연동 라이브러리(4-0)이므로 각 절에서 **정해진 것**과 **설계 과제**를 구분한다. 근거가 된 조사는 `docs/DSH.md`·`docs/DREAMVERSE.md`·`docs/LEGACY.md`에, 결정의 출처는 `docs/DECISIONS.md`에, 만드는 순서는 `docs/ROADMAP.md`에 있다. 낱말의 뜻은 `AGENTS.md` "용어"를 따른다.

## 목표와 제약

- **무엇을 만드나**: 1인 사용자용 AI 보조 에셋 제작 스튜디오다. ComfyUI(local, Comfy Cloud, RunPod Serverless, Modal)로 이미지·영상을 만들고, 채팅의 에이전트가 워크플로 그래프를 고쳐 실행하며, 결과를 프로젝트와 에셋으로 관리한다. 기존 `comfy-studio`(Next.js 단일 앱)가 하던 일이고, 이 저장소가 그것을 대체한다.
- **왜 다시 만드나**: 에이전트 코어(LLM 프로바이더, 대화, 도구 루프, MCP, 스킬, 예약)를 직접 유지하지 않고 DeepSeek Harness(dsh)에 맡긴다. 우리는 ComfyUI 도메인에만 집중한다.
- **dsh 위에 얹는다**: dsh를 포크하지 않는다. 우리 코드는 번들과 전용 프로필로 얹는 플러그인이다.
- **DreamVerse Harness를 본뜬다**: 서버 쪽은 네 계층, 화면은 가운데 작업 화면 + 우측 패널 채팅이다.
- **기존 앱에서 이어 가는 것**: 1인 사용자, 로컬 우선(폴더와 파일), 비밀값은 서버에서만 읽는다.
- **플랫폼이 주는 제약**: 브라우저 코드는 dsh가 공유하는 React 18.3.1 위에서 돈다. 플러그인 수준의 확장점(슬롯, 서비스, 이벤트)만 쓴다.

## 기술 스택

버전은 2026-11-25~26에 확인한 값이다. "확인에 쓴 버전"은 그 버전으로 실제로 돌려 봤다는 뜻이다. "고정"이라고 적은 것은 `package.json`에 정확한 버전으로 적혀 있다(1-0).

| 영역             | 선택                                                                                                                                                              | 이유·비고                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기반             | DeepSeek Harness `@deepseek-ai/dsh` **0.2.2-rc.5** 고정(MIT)                                                                                                      | 에이전트 코어, 웹 클라이언트, 플러그인 체계를 준다. `@deepseek-ai/dsh-*`는 전부 이 버전으로 맞춘다. `cordis`와 `schemastery`는 버전 줄이 따로다(아래 두 줄). |
| 런타임           | Node.js 24.9.0 이상(확인에 쓴 버전 24.22.3)                                                                                                                       | dsh의 요구다.                                                                                                                                              |
| 패키지 관리      | pnpm 워크스페이스, **10.34.8** 고정(`packageManager`). 업스트림은 11.28.5다                                                                                       | `dsh plugin` 명령이 프로필 디렉터리에서 pnpm을 부른다. pnpm 10은 의존성의 설치 스크립트를 돌리지 않는다(`docs/DSH.md` "함정").                            |
| 언어             | TypeScript **6.0.3** 고정, strict, ESM                                                                                                                            | 업스트림과 DreamVerse가 쓰는 줄(`^6.0.3`)이다. dsh의 peer 허용 범위는 `>=5 <7`이다. 공통 옵션은 `tsconfig.base.json`에 있다. 스크립트와 플러그인의 호스트 절반은 `.ts`를 Node가 바로 실행한다(빌드 없음, 지울 수 있는 문법만). 빌드하는 것은 브라우저 절반뿐이다. 브라우저 절반이 있는 패키지는 호스트·브라우저 두 프로그램으로 타입 검사한다(`docs/DSH.md` "플러그인 패키지 하나의 모양"). |
| 플러그인 체계    | Cordis `@deepseek-ai/cordis` 4.1.0(dsh 0.2.2-rc.5가 끌고 온다)                                                                                                    | `inject`, `apply(ctx)`, `Service`, `ctx.effect`.                                                                                                           |
| 스키마           | zod 4.6.x(브라우저 공유 모듈 표에 있다), `@deepseek-ai/schemastery` 3.19.0(플러그인 설정, dsh가 끌고 온다)                                                        | 외부 데이터는 스키마로 좁힌다.                                                                                                                             |
| 브라우저 UI      | React **18.3.1**과 react-dom(dsh 공유 모듈이라 브라우저 번들에 싣지 않는다), dsh 슬롯, dsh 기본 부품, `@tanstack/react-virtual` 3.14.10(공유)                     | React 19 전용 API와 그것을 요구하는 라이브러리는 쓸 수 없다.                                                                                               |
| 스타일           | 직접 쓴 CSS(우리 클래스에만 적용) + dsh 색 토큰 `--dsw-alias-*`                                                                                                   | 다크 모드가 토큰으로 따라온다. CSS Modules(`*.module.css`)로 싣는다(`docs/DSH.md` "CSS").                                                                           |
| 브라우저 번들    | esbuild 0.28.2로 CJS 본문을 만들어 dsh 로더 형식으로 감싼다. CSS Modules는 lightningcss 1.33.0(`scripts/build-client.ts`)                                                                                       | 업스트림 빌드 프리셋은 npm에 없다. 형식은 `docs/DSH.md` "브라우저 번들 형식"에 있다.                                                                                |
| 브라우저 쪽 타입 | dsh 패키지를 `0.2.2-rc.5`로 devDependency 고정(타입만 가져온다), `@types/react` 18                                                                                | 이 패키지들의 npm `latest`는 옛 버전이다. 어느 패키지가 필요한지는 `docs/DSH.md` "타입을 얻는 패키지"에 있다.                                              |
| 생성 백엔드      | ComfyUI HTTP·WebSocket, Comfy Cloud, RunPod Serverless(+ 네트워크 볼륨 S3), Modal 게이트웨이                                                                      | 기존 `lib/comfy`를 `@cs/comfy`로 옮겼다(4-0. `docs/LEGACY.md`).                                                                                                               |
| LLM              | dsh가 관리한다: DeepSeek, 내장 프로바이더 목록(`anthropic`, `openai` 등), 사용자 지정 API(OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini)  | 우리 코드에 LLM SDK를 두지 않는다.                                                                                                                         |
| 저장             | 프로젝트는 폴더 + 추가 전용 기록 파일(`<프로젝트 폴더>/.comfy-studio/records.jsonl`), 대화·설정·자격 증명은 dsh(`$DSH_HOME`)                                      | 프로젝트를 넘는 데이터의 자리는 설계 과제다(아래 "데이터가 사는 곳").                                                                                      |
| 테스트           | Vitest 5.1.2(단위, `pnpm test`), dsh를 실제로 띄우는 조합 시험(`pnpm test:integration`, 틀은 `tests/harness/`), 헤드리스 Chromium(`playwright-core` 1.65.1)으로 화면 확인 | 기존 `lib/comfy` 테스트가 Vitest다. 호스트 쪽 서비스는 프로브 플러그인이 시나리오 모듈을 dsh 안에서 실행해 확인한다(`docs/DSH.md` "띄워서 확인하는 법"). |
| 린트·포맷        | oxlint 1.95.0(타입 기반 규칙은 `oxlint-tsgolint` 7.0.2009), Prettier 3.10.1                                                                                       | 사용자가 골랐다(2026-11-26). Prettier 설정은 기존 저장소의 것이고 Markdown은 대상이 아니다. 타입 기반 린트 규칙을 켰다(사용자가 정함, 2026-11-27. 기다리지 않은 Promise 등을 잡는다. `docs/archive/PLAN_1-2.md` "사용자가 정한 것"). oxlint의 `react` 플러그인을 켰다(규칙 넷은 `docs/archive/PLAN_1-1.md` "린트 규칙"). |

**쓰지 않는 것**: Astryx와 StyleX, React 19, Next.js, Tailwind, UI 컴포넌트 라이브러리, 자체 LLM SDK 연동, 자체 채팅 구현.

## 전체 구조

```
브라우저 ── dsh 웹 클라이언트 (React 18.3.1)
┌───────────────┬──────────────────────────────┬─────────────────────────┐
│ 왼쪽 사이드바 │ 가운데                       │ 우측 패널(탭)           │
│  브랜드       │  작업 화면                   │  Chat ← dsh 채팅·입력창 │
│  프로젝트 목록│  (갤러리, 워크플로, 검토 …)  │  그 밖의 우리 탭        │
│  [우리]       │  [우리]                      │  [dsh + 우리]           │
└───────────────┴──────────────────────────────┴─────────────────────────┘
      │ 슬롯에 등록(브라우저 절반)            │ HTTP `/api/cs/…` · 이벤트 스트림 `/cs/events`
      ▼                                        ▼
dsh 호스트 (Node, Cordis)
  dsh 코어   LLM 프로바이더 · 세션 · 도구 루프 · MCP · 스킬 · 예약 · 자격 증명 · 저장소 · 웹 서버
  우리 플러그인
    화면용 API ─▶ 프로젝트 계층 ◀─ 기능 컴포넌트 ◀─ 작업 절차(스킬)
                  (연산 실행 · 기록 · 히스토리 · 상태)
                                   기능 컴포넌트 ─▶ 카탈로그 ◀─ 생성 프로바이더
                                                                   │
                                                                   ▼
                                              ComfyUI local · Comfy Cloud · RunPod · Modal
```

화살표는 의존 방향이다. 거꾸로 의존하지 않는다.

## 네 계층

DreamVerse의 구조를 가져온다. 원본 설명은 DreamVerse 저장소의 `docs/subsystems/video-harness.md`이고, 요약과 가져올 범위는 `docs/DREAMVERSE.md`에 있다.

| 계층                        | DreamVerse                                             | 역할                                                                                                                                             |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. 프로젝트 계층            | `@dv/project` → 우리 `@cs/project`(2-0)                | 기능 컴포넌트가 연산과 리듀서를 등록하는 곳이다. 기록 파일의 유일한 작성자다. 연산을 에이전트 도구로 내놓고, 히스토리(실행 취소·다시 실행)를 관리하고, 프로젝트 상태를 에이전트에게 알린다. |
| 2. 카탈로그와 생성 프로바이더 | `@dv/models` + 프로바이더 플러그인                   | "무엇으로 생성할 수 있는가"의 목록이다. 생성 프로바이더가 항목을 등록하고 기능 컴포넌트가 그것으로 생성한다. 우리 쪽 생성 프로바이더는 Comfy 연결(계획 4)이 만든다. |
| 3. 기능 컴포넌트            | `@dv/asset-pool`, `@dv/character`, `@dv/shot-render` … | 능력 하나씩을 소유하는 플러그인이다. 자기 데이터(상태 조각과 리듀서), 자기 연산, 에이전트가 읽는 자기 설명을 가진다.                             |
| 4. 작업 절차(스킬)          | `@dv/workflow-story`                                   | 기능 컴포넌트의 도구를 어떤 순서로 부를지를 스킬로 적는다. DreamVerse는 이 계층을 "workflows"라고 부르지만 여기서는 ComfyUI 워크플로와 헷갈리지 않게 "작업 절차"라고 부른다. |

네 계층 옆에 셋이 더 있다.

- **화면용 API**(`@dv/api` → 우리 `@cs/api`, 2-2): 화면이 프로젝트를 읽고 바꾸는 유일한 길이다.
- **화면**(`@dv/ui-*`): 가운데 뷰와 우측 패널 탭이다.
- **번들**(`@dv/bundle`): 위 패키지들의 플러그인 행과 에이전트 프리셋을 모은 프로필 계층이다.

가져오는 규칙(DreamVerse 문서의 "Where new behavior goes"):

1. **모든 것에는 주인이 하나다.** 데이터, 능력, 에이전트가 읽는 글은 각각 한 플러그인에 속한다.
2. **의존은 한 방향이다.** 화면 → 화면용 API → 프로젝트 계층 ← 기능 컴포넌트 ← 작업 절차. 기능 컴포넌트 → 카탈로그 ← 생성 프로바이더.
3. **기능 컴포넌트는 다른 기능 컴포넌트의 연산을 이름으로 부르지 않는다.** 작업 절차는 기능 컴포넌트를 도구로만 부른다.
4. **바꿔 끼울 수 있는 능력만 계약으로 뺀다.** 구현이 둘 이상일 때만 계약 패키지와 구현 패키지로 나눈다.
5. **에이전트가 읽는 글은 주인과 함께 둔다.** 도구 하나의 쓰는 법은 그 연산의 설명에, 여러 기능 컴포넌트에 걸친 절차는 스킬에, 매 턴 바뀌는 프로젝트 상태는 프로젝트 계층의 상태 메시지에 둔다.

### 프로젝트 계층 — `@cs/project`

2-0에서 DreamVerse `@dv/project`를 옮겼다(`packages/project`, 호스트 절반만 있다). 서비스는 `ctx.csProject`다. 모듈마다의 함수·규칙·오류·시험 목록은 `packages/project/CONTRACTS.md`에 있다. 아래의 동작은 단위 시험과 조합 시험으로 확인했다(**띄워 확인**, 2026-11-27).

기능 컴포넌트가 쓰는 법(전부 `ctx.effect` 안에서 등록하고 돌려받은 함수로 뺀다):

```ts
import type {} from "@cs/project";                    // ctx.csProject의 타입
declare module "@cs/project" {
  interface ComponentStates { note?: { texts: string[] } }   // 자기 상태 조각을 선언 병합으로 더한다
}
export const inject = ["csProject"];
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.csProject.registerComponent("note"));          // 열쇠가 먼저다
  ctx.effect(() => ctx.csProject.registerReducer("note", reducer));   // initial(), reduce(slice, record), agentSummary?()
  ctx.effect(() => ctx.csProject.registerOperation(spec));            // 이름은 "<열쇠>.<동사>". 도구 cs_note_add가 같이 생긴다
}
```

| 하려는 것 | 부르는 것 |
| --- | --- |
| 프로젝트 만들기, 목록, 이름 바꾸기, 빼기 | `newProjectFolder(name)` → `createProject(folder, title, origin)`, `listProjects()`, `openProject(id)`, `renameProject(id, title)`, `removeProject(id)`(파일은 지우지 않는다) |
| 프로젝트를 바꾸기 | `run({ ...origin, project, operation, params, inputs })`. 유일한 변경 길이다. 미리 물어보는 것은 `check(request)` |
| 히스토리 | `undo(id)`, `redo(id)`, `moveTo(id, record)`, `line(id)`(`{ tip, at }`), `listHistory(query)` |
| 읽기 | `getState(id)`(리듀서마다의 조각), `getRecord`, `listRecords`, `subscribe(id, listener)` |
| 채팅 세션의 프로젝트 | `sessionProject(sessionId)`: 세션의 작업 폴더가 프로젝트 폴더인 프로젝트 |
| 에셋 | `registerAssetStore(store)`: 에셋 기능 컴포넌트 `@cs/asset`(2-3b)이 등록한다. 그것이 없으면 아무 에셋도 없는 빈 저장소가 대신한다. 프로젝트 계층 밖에서 읽을 때는 `assets()`(`has`·`get`·`url`만 있다. 화면용 API가 쓴다) |

- `origin`은 누가(`actor`: `user`·`agent`·`system`), 어디서(`surface`: `chat`·`view`·`api`·`history`), 어느 세션·턴·도구 호출에서, 왜(`intent`) 했는지다. 기록마다 남는다. `view`는 우리 화면에서 한 사용자 동작이다.
- 프로젝트 폴더의 `.comfy-studio/`에 `records.jsonl`(기록 줄과 갱신 줄, 추가만 한다)과 `line.json`(히스토리의 끝 `tip`과 현재 위치 `at`)이 있다. 이 디렉터리는 프로젝트 계층만 읽고 쓴다.
- 에이전트에게 가는 것: 연산마다의 도구 `cs_<연산 이름>`, 프로젝트 도구 여덟 개(`cs_proj_create`, `_rename`, `_state`, `_history_list`, `_undo`, `_redo`, `_stale_accept`, `_wait`), 시스템 프롬프트의 `cs:project` 절(규칙만), 대화에 덧붙는 프로젝트 상태 메시지와 갱신 메시지. 에이전트가 이 도구들을 받고 규칙 절과 두 메시지가 실제 턴에 붙는다(**띄워 확인**, 2026-11-28: 실제 모델과 조합 시험 `tests/integration/chat.test.ts`. `docs/DSH.md` "실제 모델로 확인한 것").
- 설정(번들의 `cs-project` 행): `projectsFolder`(새 프로젝트 폴더를 둘 곳. 환경 변수 `CS_PROJECTS_FOLDER`에서 읽고, 없거나 비어 있으면 `<사용자 홈>/comfy-studio-projects`), `cpuConcurrency`(4), `gpuConcurrency`(1), `promptSectionOrder`(4900).
- 프로젝트 규칙 절은 DreamVerse의 것을 뜻 그대로 옮겼다("모든 호출은 바로 히스토리의 단계다. 사용자가 변경을 승인하지 않는다"). 2-3a에서 예외를 더했다: 설명에 제안이라고 적힌 도구는 아무것도 바꾸지 않고 사용자의 결정을 기다린다(아래 "제안과 승인").

### 변경 하나가 흐르는 길

화면과 에이전트는 같은 연산을 부른다. 화면의 동작은 화면용 API를 거쳐 `actor: 'user'`로, 에이전트는 연산의 도구를 불러 `actor: 'agent'`로 실행한다. 어느 쪽이든 프로젝트 계층의 실행기를 지난다(DreamVerse `@dv/project`의 흐름이다).

1. 파라미터를 검증한다.
2. 프로젝트 잠금 안에서 입력을 에셋으로 풀고, 연산의 사전 조건을 확인한다. 여기서 거절되면 기록이 남지 않는다.
3. `pending` 기록을 추가한다.
4. 잠금 밖에서 기능 컴포넌트의 구현을 실행한다.
5. 출력·비용·보고를 갱신 줄로 추가한다.
6. 이벤트 스트림으로 알리고, 화면은 상태를 다시 읽는다.

기록은 추가만 하고 고쳐 쓰지 않는다. 현재 상태는 기록을 리듀서에 흘려 계산한다. 실행 취소·다시 실행·"이 단계로 돌아가기"는 현재 위치만 옮긴다. 어떤 화면도 프로젝트 상태를 따로 들고 있지 않는다.

### 에이전트가 쓰는 도구

- 연산이 곧 에이전트 도구다. 프로젝트 계층이 등록된 연산을 도구로 내놓는다.
- 에이전트가 그 밖에 무엇을 가질지는 **에이전트 프리셋**이 정한다. dsh의 기본 프리셋(`standard`)은 셸과 파일 도구를 준다. 그 도구가 있으면 에이전트가 기록을 거치지 않고 프로젝트 폴더를 고치거나 지울 수 있다.
- **우리 프리셋 `comfy-studio`는 셸과 파일 도구를 주지 않는다**(1-4에서 사용자가 정했다, 2026-11-28). 번들(`packages/bundle/cordis.patch.yml`)에 있고 기본 프리셋이다. 에이전트가 dsh에서 받는 것은 스킬(`skill`), 사용자에게 묻기(`ask_user_question`), 웹 가져오기(`web_fetch`), 할 일(`todo_write`), 서브에이전트(`subagent`, `list_agents`, `send_message`, `wait_agent`) 여덟 개다. dsh의 예약 도구는 넣지 않았다(모든 예약을 고치고 승인 없이 지운다. 예약은 사용자가 Automation tasks 화면에서 만든다). 조합 시험 `tests/integration/preset.test.ts`가 도구 목록이 정확히 이것과 우리 도구인지 본다. 구성과 근거는 `docs/DSH.md` "에이전트 프리셋"에 있다.
- **우리 화면의 버튼이 만드는 세션은 늘 이 프리셋이다.** 셸이 세션을 만들 때 프리셋을 명시한다. dsh의 기본 제공 프리셋은 끄지 않았다(끄면 그 프리셋의 기존 세션에 글이 보내지지 않는다).
- **dsh 자체의 진입점은 설정의 기본 프리셋을 따른다**(브랜드에 키보드로 Enter, 새 세션 단축키, 새 브라우저의 시작 복원, Automation tasks의 New task). 기본값은 번들이 우리 것으로 두지만 사용자가 설정에서 바꿀 수 있다. 그래서 **셸이 프로젝트의 빈 채팅을 지켜보다가 우리 프리셋이 아니면 우리 것으로 되돌린다**(사용자가 정했다, 2026-11-28. `packages/ui-shell/src/client/follow.ts`의 `followAgentPreset`). 남는 것: 만들자마자 글이 들어가는 세션(예약이 실행되며 만드는 새 세션)과 이미 대화가 있는 세션은 가진 프리셋 그대로다. 사용자가 기본값을 `standard`로 바꾼 home에서만 생긴다.
- 프로젝트 문서는 파일이 아니라 기능 컴포넌트의 연산으로 만든다(`docs/LEGACY.md` "대응표").

### 제안과 승인

기존 앱의 규칙 "에이전트는 아무것도 직접 지우지 않는다, 캐릭터 프로필과 프리셋을 직접 쓰지 않는다"를 지키는 장치다. 사용자가 "제안 기록 + 승인"으로 정했고(2026-11-28, `docs/DECISIONS.md` "확정") 2-3a에서 프로젝트 계층에 만들었다. 아래의 동작은 단위 시험과 조합 시험으로 확인했다(**띄워 확인**, 2026-11-29: `tests/integration/proposal.test.ts`가 가짜 LLM으로 실제 dsh에서 제안 → 승인 → 실행 → 다음 턴의 갱신을 본다).

연산마다 에이전트가 부르면 무엇이 되는지를 `OperationSpec.agent`로 정한다.

| 값 | 에이전트 도구 | 에이전트가 부르면 | 쓰는 곳 |
| --- | --- | --- | --- |
| `run`(적지 않으면 이것) | 있다 | 바로 실행된다. 히스토리의 단계다 | 대부분의 연산 |
| `propose` | 있다 | 실행되지 않고 제안이 남는다. 사용자가 승인하면 같은 연산이 사용자 이름으로 실행된다 | 삭제, 캐릭터 프로필 쓰기 |
| `none` | 없다 | — | 사용자만 하는 일: 채택과 보류, 화면에서 올린 파일의 가져오기 |

- **화면과 에이전트가 같은 연산을 부른다는 규칙은 그대로다.** 사용자는 화면에서 `propose` 연산을 바로 실행한다. 제안 전용 연산은 없다.
- **한 곳에서 막는다.** `ctx.csProject.run`은 `actor: "agent"`인 요청이 `propose`·`none` 연산을 부르면 기록 없이 거절한다(`agent_not_allowed`).
- **제안은 히스토리 밖의 기록이다.** `proj.propose`(연산 이름, 파라미터, 입력)와 `proj.proposal_decide`(제안, 결정, 승인으로 실행된 기록) 둘이고, 단계가 아니라서 실행 취소로 사라지지 않고 뒤 단계를 버리지 않는다. `proj` 조각의 `proposals`가 이 둘에서 계산한 목록이다(`pending`·`accepted`·`rejected`).
- **제안할 때와 승인할 때 둘 다 검사한다.** `ctx.csProject.propose(request)`는 `run`이 기록 전에 하는 검사(파라미터, 입력, `precondition`)를 그때의 상태로 하고, 걸리면 기록 없이 거절한다(에이전트에게는 도구 오류다). `ctx.csProject.decideProposal(project, proposal, "accept" | "reject", origin)`의 승인은 연산을 사용자 origin으로 `run`하므로 그때의 상태로 다시 검사된다. 기록 전에 거절되면 제안은 대기로 남고 오류가 사용자에게 간다.
- **두 번 실행되지 않는다.** 이미 결정된 제안의 결정은 아무것도 쓰지 않고 지금 상태를 돌려준다. 같은 제안의 결정이 진행 중이면 `proposal_busy`다. 결정은 사용자만 한다(`actor: "agent"`인 결정은 `agent_not_allowed`). 에이전트의 히스토리 이동(`cs_proj_undo`, `cs_proj_redo`)도 `propose`·`none` 연산의 단계를 넘지 못한다: 사용자가 실행 취소한 삭제를 되살리지도, 사용자의 검토를 되돌리지도 못하고 `agent_not_allowed`로 거절된다(2026-11-29). 같은 세션이 같은 연산·파라미터·입력으로 낸 대기 중 제안은 하나로 접힌다.
- **에이전트가 아는 것.** 도구 결과가 "제안했고 아직 바뀐 것은 없다"를 말한다(오류가 아니다). 대기 중인 제안은 프로젝트 요약의 `proposals`에, 사용자의 결정은 프로젝트 갱신 메시지의 줄로 간다. 프로젝트 규칙 절이 제안 도구를 되풀이해 부르지 말라고 적는다.
- **화면이 하는 것.** 제안 목록은 상태(`GET /api/cs/state`)의 `components.proj.proposals`에 있고, 결정은 `POST /api/cs/proposal/decide`다. 채팅 안의 카드는 3-4에서 그린다. 그때까지 화면에는 승인하는 곳이 없다.
- 만료는 없다. 결정된 제안도 상태에 남는다.
- 프리셋은 프로젝트 밖의 데이터라(아래 "데이터가 사는 곳") 프리셋 변경의 제안이 이 장치를 쓸지는 2-3f에서 정한다.

### 에셋 — `@cs/asset`

첫 기능 컴포넌트다(2-3b). 프로젝트의 에셋(이미지, 영상, 오디오, 그 밖의 파일)과 그 라이브러리(폴더, 태그, 검토 상태)를 맡는다. 아래는 단위 시험과 조합 시험 `tests/integration/asset.test.ts`로 확인했다(**띄워 확인**, 2026-11-29). 상세는 `docs/archive/PLAN_2-3b.md`.

**파일.** 프로젝트 계층의 에셋 저장소(`AssetStore`)로 등록된다. 파일은 프로젝트 폴더 안에 산다.

```
<프로젝트 폴더>/.comfy-studio/assets/objects/<sha256>        바이트. 한 번 쓰고 고치지 않는다
<프로젝트 폴더>/.comfy-studio/assets/index.jsonl             에셋마다 한 줄(뒤의 줄이 이긴다). 추가만 한다
<프로젝트 폴더>/.comfy-studio/assets/thumbs/<sha256>.webp    썸네일. 지워도 다시 만든다
```

에셋 id는 바이트의 SHA-256이다. 같은 파일을 한 프로젝트에 두 번 넣으면 에셋 하나다. `.comfy-studio/` 가운데 `assets/`는 이 컴포넌트만 읽고 쓴다. 크기(가로·세로)와 길이는 ffmpeg 서비스(`@cs/ffmpeg`, `ctx.csFfmpeg`)가 있으면 읽어 색인에 덧붙이고 썸네일도 그것으로 만든다. ffmpeg이 없으면 그 칸들이 비고 썸네일이 없을 뿐 나머지는 그대로 돈다. ffmpeg은 에셋을 읽을 때 로컬 파일만 연다(`-protocol_whitelist file`).

**라이브러리.** 상태 조각 `asset`은 `{ items, folders, marks }`다(`@cs/asset/types`). 리듀서가 기록에서 계산한다.

- 어느 컴포넌트의 것이든 끝난 기록의 출력은 라이브러리에 **검토 대기**(`pending`)로 들어온다. 사람이 가져온 것은 **채택**(`adopted`)으로 들어온다. 리듀서는 다른 컴포넌트의 연산 이름을 보지 않는다. 기존 규칙 "생성의 출력은 검토 대기로 들어오고 사용자가 채택한다"가 이것이다.
- 가져오기(`asset.import`)만 히스토리 밖이고 나머지는 단계다. 가져온 파일은 실행 취소로 사라지지 않고, 폴더·태그·검토·삭제는 되돌릴 수 있다.
- 리듀서는 히스토리의 기록을 다 받은 뒤에 히스토리 밖의 가져오기를 받는다. 그래서 가져오기보다 나중에 일어난 단계를 먼저 본다. `marks`(라이브러리에 없는 에셋에 대해 단계가 말한 것)와 기록의 시각(`created_at`)으로 실제 시각 순서와 같은 결과를 낸다. 화면은 `marks`를 보지 않는다.
- 삭제는 상태에서만 일어난다. 파일은 남는다(실행 취소가 되돌린다). 쓰이지 않는 파일의 정리는 2-8에서 본다.

**연산.** 전부 `asset.` 아래다.

| 연산 | 에이전트가 부르면 | 하는 일 |
| --- | --- | --- |
| `asset.import` | 도구 없음 | 저장소에 있는 바이트를 라이브러리에 들인다(히스토리 밖). 올리기 라우트가 사용자로 실행한다 |
| `asset.review` | 도구 없음 | 채택하거나 보류한다. 사용자만 한다 |
| `asset.move`, `asset.tag` | 바로 실행 | 폴더로 옮긴다, 태그를 붙이고 뗀다 |
| `asset.folder_create`, `asset.folder_update` | 바로 실행 | 폴더를 만든다, 이름을 바꾸거나 옮긴다. 폴더의 id는 만든 기록의 id다 |
| `asset.delete`, `asset.folder_delete` | 제안 | 라이브러리에서 뺀다. 폴더와 하위 폴더를 지운다(안의 에셋은 루트로 간다) |
| `asset.list` | 읽기 | 라이브러리를 읽는다. 기본은 채택된 것만이고 최신순이다. 폴더·검토 상태·종류·낱말·태그로 거르고 커서로 넘긴다 |

한도(기록 전에 거절한다): 폴더 깊이 4, 형제 폴더의 이름은 대소문자 없이 겹치지 않는다, 태그는 소문자로 40자까지, 한 에셋에 50개까지. 에이전트 요약에는 검토 상태별 개수(`assets`)와 폴더 목록(`asset_folders`)이 실린다.

**라우트.** dsh `connection`의 fetch 라우트로 직접 등록한다(인증은 dsh가 한다. 소유자만 닿는다). 화면용 API는 기능 컴포넌트를 모른다.

| 경로 | 메서드 | 요청 | 응답 |
| --- | --- | --- | --- |
| `/api/cs/asset` | GET, HEAD | `id`, `download?` | 바이트. `Range: bytes=a-b` 하나를 받는다(206, 틀리면 416) |
| `/api/cs/asset/thumb` | GET, HEAD | `id` | 512px 안에 드는 WebP. 만들 수 없으면 404 |
| `/api/cs/asset/upload` | POST | 쿼리 `project`, `name`, `mime`, `folder?`, `session?`, `surface?`. 본문은 파일의 바이트 | `{asset, record}`: 저장소에 넣고 `asset.import`를 사용자로 실행한다 |
| `/api/cs/asset/stage` | POST | 쿼리 `project`, `name`, `mime`. 본문은 파일의 바이트 | `{asset}`: 저장소에 넣기만 한다. 다른 기능 컴포넌트의 연산이 그 id를 입력으로 받는다 |

- **화면에 바로 그려도 되는 종류만 제 종류로 준다**(PNG·JPEG·WebP·GIF·AVIF, MP4·WebM·QuickTime, 흔한 오디오). 그 밖은 HTML과 SVG를 포함해 `application/octet-stream` 첨부다. 올린 파일의 스크립트가 우리 출처에서 돌지 않게 한다. 모든 응답에 `X-Content-Type-Options: nosniff`와 `Content-Security-Policy: sandbox; default-src 'none'`이 붙는다.
- id가 내용이라 `Cache-Control: private, max-age=31536000, immutable`이다.
- 올리기는 본문을 프로젝트의 `objects/` 안 임시 파일로 바로 받으며 해시를 내고, 끝나면 이름만 바꾼다(파일을 다시 읽거나 복사하지 않는다). 한도는 설정 `maxUploadBytes`(번들의 `cs-asset` 행. 기본 2GiB)이고 넘으면 413이다. 화면은 올리기 전에 크기를 본다: 한도를 한참 넘는 본문은 서버가 다 읽지 않고 연결을 끊어 브라우저가 답을 받지 못한다.
- 에이전트와 카드에 보이는 에셋 주소의 앞부분은 설정 `publicBaseUrl`이다(기본은 빈 값이라 상대 주소다).

### 워크플로 — `@cs/workflow`

프로젝트의 워크플로(ComfyUI API 형식 그래프와 노출 필드)를 맡는 기능 컴포넌트다(2-3c). 아래는 단위 시험과 조합 시험 `tests/integration/workflow.test.ts`로 확인했다(**띄워 확인**, 2026-11-29). 상세는 `docs/archive/PLAN_2-3c.md`.

- **워크플로는 템플릿이다.** 그래프를 덮어쓰는 연산이 없다. 그래프를 바꾸는 길은 그래프 패치뿐이고, 남기려면 변형(새 워크플로)으로 저장한다. 원본은 그대로 남는다.
- **그래프는 블롭이다.** 그래프 JSON은 에셋 저장소에 정규화한 JSON 파일로 들어가고(노드 id 순, 열쇠 순. 같은 그래프는 같은 id) 기록과 조각에는 그 id만 있다. 연산의 출력이 아니라 `report`에 적으므로 에셋 라이브러리에 뜨지 않는다. 상태가 가벼워진다.
- 조각 `workflow`는 `{ items }`다(`@cs/workflow/types`의 `WorkflowItem`: 이름, 설명, 그래프 id, 필드, 부모, 기본 실행 자리, 노드 수). 항목의 id는 만든 기록의 id다.
- 그래프와 필드의 로직은 연동 라이브러리 `@cs/comfy`의 순수 함수다(파싱, 필드 추론, 패치 적용과 검증, PNG에서 그래프 읽기, 그래프를 글로). 그 라이브러리가 내는 문장(패치 오류, 그래프 문제)은 한국어다.

| 연산 | 에이전트가 부르면 | 하는 일 |
| --- | --- | --- |
| `workflow.create` | 도구 없음 | 올린 파일(API 형식 JSON, ComfyUI가 만든 PNG)에서 워크플로를 만든다. 파일은 먼저 `/api/cs/asset/stage`로 올린다 |
| `workflow.update` | 도구 없음 | 이름, 설명, 노출 필드, 기본 실행 자리를 고친다 |
| `workflow.copy` | 도구 없음 | 다른 프로젝트의 워크플로를 복사해 온다 |
| `workflow.save_variant` | 바로 실행 | 그래프 패치를 적용한 그래프를 변형으로 남긴다 |
| `workflow.delete` | 제안 | 워크플로를 지운다 |
| `workflow.list`, `workflow.get`, `workflow.graph`, `workflow.check_patch` | 읽기 | 목록, 필드, 그래프의 글(길면 종류별 요약을 주고 노드를 골라 읽게 한다), 패치를 적용해 본 결과 |

- 서버 없이 되는 검사(파일 파싱, 패치 적용, 구조 검사, 필드가 그래프에 묶이는지)는 기록 전에 한다. 서버의 노드 정보(카탈로그 `graph` 항목의 `nodeCatalog()`)가 있으면 실행 때 종류·범위·연결까지 검사하고 필드를 추론한다. 없거나 20초 안에 답하지 않으면 구조 검사만 한다.
- 선택지가 50개를 넘는 필드는 선택지를 싣지 않는다(서버의 모델 파일 목록을 기록에 박지 않는다).
- 다른 기능 컴포넌트는 조각을 직접 뒤지지 않고 서비스에 묻는다: `ctx.csWorkflow.resolve(state, id)`(항목과 파싱한 그래프), `ctx.csWorkflow.objectInfo(target)`(그 자리의 노드 정보).
- 에이전트 요약에 `workflows`(id, 이름, 설명, 필드 id. 30개까지)가 실린다.

## 두 계약

계획 2가 먼저 정해야 하는 것이다. 이 둘이 정해져야 계획 3(화면)과 계획 4(Comfy 연결)가 따로 갈 수 있다. 화면용 API는 2-2에서, 카탈로그 계약은 2-1에서 만들었다.

### 카탈로그 계약 — `@cs/catalog`

생성 프로바이더가 꽂히는 자리다. 2-1에서 정하고 만들었다(`packages/catalog`, 호스트 절반만 있다). 서비스는 `ctx.csCatalog`이고 번들의 행은 `cs-catalog`다. 사용자가 고른 모양이다(2026-11-28, `docs/DECISIONS.md` "확정"): 항목은 등록된 서버 하나, 요청은 완성된 그래프이고 결과는 이벤트 스트림, 검증은 기록 전에 하고 서버의 거절은 실행으로 세지 않는다. 틀(프리미티브마다의 타입 표와 선언 병합, 등록·조회·변경 알림)은 DreamVerse `@dv/models`를 따랐고, 요청과 항목의 모양은 ComfyUI에 맞게 새로 정했다. 아래의 동작은 단위 시험과 조합 시험으로 확인했다(**띄워 확인**, 2026-11-28: 가짜 생성 프로바이더로 실제 dsh 안에서 돌렸다. 실제 ComfyUI 서버로는 돌리지 않았다. 4-2의 일이다).

**항목.** 카탈로그는 "어디서 돌릴 수 있는가"의 목록이다. 열쇠는 `{ primitive, provider, target }`이고, 지금 프리미티브는 `graph` 하나다. `graph` 항목 하나는 프로바이더가 등록한 ComfyUI 서버 하나이고 `target`이 그 서버의 id다. 워크플로(템플릿)는 카탈로그에 없다. 워크플로 기능 컴포넌트의 데이터다. 그래프가 아닌 생성이 생기면 그 패키지가 선언 병합으로 프리미티브를 더한다.

| 항목의 멤버 | 하는 일 |
| --- | --- |
| `description` | 에이전트와 사용자가 항목을 고를 때 읽는 글 |
| `facts()` | 서버에서 읽은 사실: `{ label, kind, system }`. `kind`는 프로바이더가 붙인 서버 종류(local, cloud, runpod, modal)다. 서버에 닿지 못하면 거절한다 |
| `validate(draft, signal?)` | 큐에 넣지 않는 검증. 문제마다 에이전트가 읽을 문장 하나를 주고, 없으면 빈 목록이다. 받는 것은 입력이 에셋으로 풀리기 전의 요청(`GraphDraft`: 그래프와, 미디어 입력이 들어갈 자리 `{ node, input }`)이고, 그 자리의 리터럴은 자리표시자라 판단하지 않는다. 부르는 쪽이 기록을 쓰기 전에 프로젝트 잠금 안에서 부르므로 프로바이더가 이미 가진 것(캐시한 노드 카탈로그)으로 답한다. 가진 것이 없으면 빈 목록을 주고 거절을 `run`에 맡기거나 바로 거절한다. 서버를 오래 기다리지 않는다 |
| `run(request, { dir, assets, signal })` | 실행한다. 이벤트의 흐름을 준다(아래). 순회를 시작할 때까지 아무것도 하지 않고, 한 번만 순회한다 |
| `resume?(run, options)` | 이미 받아들여진 실행을 다시 따라간다. 있는 프로바이더만 |
| `nodeCatalog?()`, `listModelFiles?(folder)`, `modelFileMetadata?(folder, file)`, `listRuns?(limit)` | 서버 조회. 되는 서버의 항목에만 있다(기존 `ComfyBackend`의 선택 메서드와 같은 방식이다) |

**요청과 결과.** 요청(`GraphRequest`)은 실제로 보낼 API 형식 그래프 전체(`graph`. 그래프 패치와 필드 값이 이미 적용된 것)와 에셋으로 받은 미디어 입력(`media`: `{ node, input, asset }`)이다. 템플릿, 패치, 필드 값으로 그래프를 만드는 일은 기능 컴포넌트가 연동 라이브러리(`@cs/comfy`)의 순수 함수로 한다. 프로바이더는 워크플로를 모른다. 프로바이더는 실행 직전에 미디어 입력을 서버에 올리고 그 이름을 그래프에 써넣는다. 에셋은 `run`의 옵션으로 받은 리더(`assets.get`, `assets.read`)로 읽고, 부르는 쪽이 `ctx.csProject.assets()`를 넘긴다.

결과는 이벤트의 흐름(`AsyncIterable<GraphRunEvent>`)이다.

| 이벤트 | 뜻 |
| --- | --- |
| `queued { run, graph }` | 서버가 받았다. `graph`는 실제로 보낸 것(올린 입력의 이름이 들어간 뒤)이다. 부르는 쪽이 기록의 보고에 남긴다 |
| `progress { node, value, max }` | 실행 중인 노드와 단계. 서버가 말하지 않는 값은 `null`이다 |
| `output { node, name, mime, path, preview }` | 출력 파일 하나. `path`는 부르는 쪽이 준 폴더(`dir`. 연산의 `scratchDir`) 바로 아래의 파일이고, 한 실행 안에서 이름이 겹치지 않으며, 이벤트가 올 때 다 쓰여 있다. `name`은 서버가 준 표시용 이름이다. `preview`는 저장된 출력이 없을 때의 임시 출력이다 |
| `done` | 끝났다. 이 뒤에 순회가 끝나고, 그 뒤로는 거절하지 않는다. `done` 없이 끝난 순회는 끝나지 않은 실행이다 |

- **진행률, 완료 판정, 출력 수집, 취소 판정은 프로바이더가 한다**(기존 규칙 "한 곳에서 한다"). 실패는 순회가 거절된다.
- **출력은 `done` 뒤에 에셋으로 넣는다.** 부르는 쪽은 `output` 이벤트를 모아 두었다가 `done`을 받은 뒤에 `importAsset({ path }, …)`로 넣는다. 중간에 실패한 실행은 에셋을 남기지 않는다(기록이 가리키지 않는 에셋이 생기지 않는다).
- **취소**는 `signal` 하나다. 중지되면 프로바이더가 서버에 취소를 보낸다. 서버가 이미 끝냈으면 출력과 `done`까지 내서 결과를 살리고, 아니면 서버의 끝 상태를 안 뒤에 `Error`로 거절한다. 기존 앱의 취소 결과 셋(`canceled`, `running`, `finished`)이 이 둘로 접힌다. 순회를 시작할 때 이미 중지돼 있으면 아무것도 보내지 않는다.
- **순회가 일찍 끝나도 취소다.** 부르는 쪽이 중간에 순회를 그만두면(`return()`) 프로바이더가 끝나지 않은 실행을 취소한다. 순회가 어떻게 끝나든 프로바이더는 그 실행을 위해 쥔 것(연결, 서버가 따로 들고 있는 출력 사본)을 놓고, `dir`에 더 쓰지 않는다. 부르는 쪽은 순회가 끝난 뒤에 `dir`을 지운다.
- **비밀값을 내놓지 않는다.** `facts()`의 값, `validate`의 문제, `RequestRejected`의 이유, 거절하는 오류의 메시지는 기록 파일과 에이전트와 브라우저에 닿는다. 프로바이더가 서버의 답을 전할 때 키와 토큰, 그것이 든 주소를 걷어낸다.
- **검증과 거절**(기존 규칙 "`/prompt` 검증 실패는 기록을 남기지 않는다"). 부르는 연산이 `precondition`에서 `validate`를 불러, 걸리면 기록 없이 거절한다. 그것을 통과하고도 서버가 그래프를 실행하지 않고 거절하면 `run`이 `RequestRejected`(문제 목록)로 거절된다. 제출에 바로 답하는 서버(ComfyUI의 `/prompt`)는 이벤트 없이, 나중에야 알려 주는 서버(작업 큐)는 `queued` 뒤에 거절한다. 이때는 이미 `pending` 기록이 있으므로, 부르는 연산이 `OperationFailure`로 기록의 실패 코드를 `not_queued`(`NOT_QUEUED`)로 남긴다. 실행을 세는 쪽(생성 목록, 배치)은 이 코드의 기록을 뺀다. `precondition` 때는 입력이 아직 에셋으로 풀리지 않았으므로 `validate`에는 미디어 입력이 들어갈 자리만 넘긴다. `precondition`의 거절은 `ProjectError("invalid_params", …)`로 던져야 화면용 API가 400으로 답한다(그냥 `Error`는 500이 된다).
- **`ComfyBackend`와의 관계.** `ComfyBackend`(`@cs/comfy/backend`)는 카탈로그 아래의 내부 인터페이스로 남는다. 프로바이더(4-2)가 항목 하나를 `ComfyBackend` 하나 위에 구현한다. 계약 패키지는 연동 라이브러리에 의존하지 않는다(그래프 타입은 구조가 같은 자체 선언이다).

**서비스**(`ctx.csCatalog`).

| 메서드 | 하는 일 |
| --- | --- |
| `register(entry)` | 항목을 넣고 빼는 함수를 준다. 프로바이더가 `ctx.effect` 안에서 부른다. 같은 열쇠가 있거나 프로바이더·대상이 비면 던진다 |
| `get(key)`, `list(filter?)` | 열쇠로 하나, 또는 프리미티브·프로바이더로 거른 목록(등록 순) |
| `onChanged(listener)` | 등록과 해제를 듣는다. 듣는 쪽이 던져도 등록과 다른 듣는 쪽은 그대로 간다 |
| `whileServing(primitives, start)` | 그 프리미티브의 항목이 하나라도 있는 동안만 소비자의 등록(연산)을 유지한다. `start`나 그 정리 함수가 카탈로그를 바꿔도 한 번씩만 불린다 |
| `summary()` | 화면이 읽는 목록: 열쇠, 설명, 가진 선택 메서드의 이름(`abilities`), `facts`. `facts()`가 거절하거나 `factsTimeoutMs`(설정, 기본 5000) 안에 답하지 않은 항목은 `facts: null`과 `problem`으로 싣는다 |

화면은 `GET /api/cs/catalog`로 이 목록을 읽고, 이벤트 스트림의 `catalog` 이벤트로 바뀐 것을 안다(아래 "화면용 API").

**의존.** 기능 컴포넌트 → 카탈로그 ← 생성 프로바이더다. 그 밖에 둘이 더 있다: 카탈로그 계약은 프로젝트 계층의 타입(에셋 id, 에셋 읽기)을 쓰고, 화면용 API는 카탈로그를 읽기만 한다(목록과 변경 알림).

**본이 되는 시험.** `packages/catalog/src/contract.test.ts`가 실제 프로젝트 계층 위에서 계약을 끝까지 돈다: `whileServing`으로 연산을 등록하고, `precondition`에서 검증하고, `execute`에서 흐름을 끝까지 읽은 뒤 출력을 에셋으로 넣고, 거절(제출 때와 `queued` 뒤)을 `not_queued`로 남기고, 중지의 두 결과를 본다. 2-3의 생성 기능 컴포넌트와 4-2의 프로바이더가 이 모양을 따른다. 가짜 생성 프로바이더는 `@cs/catalog/testing/fake-provider`에 있다.

**정하지 않은 것.**

- 재시작 후 이어받기. 계약에 `resume`은 있지만, 프로젝트 계층은 재시작 때 끝나지 않은 기록을 `cancelled`로 끝낸다. 이어받으려면 그 규칙을 바꾸거나 실행 id를 기록 밖에 둬야 한다(4-2).
- 카탈로그를 읽는 에이전트 도구(DreamVerse의 `dv_models_list`·`dv_models_get`). 무엇을 보일지는 생성 기능 컴포넌트가 워크플로와 함께 정한다(2-3).
- 서버 id의 모양과 서버 목록의 자리(4-1).
- 실행을 구현하며 정할 것(4-2): 중지한 뒤 서버가 아직 돌고 있을 때 순회가 끝나는 시점, 큰 미디어 입력(지금 `assets.read`는 파일 전체를 메모리에 올린다), 실행 중에 항목이 빠질 때, 한 항목에서 동시에 도는 실행, 마스크 같은 다른 올리기, `facts()`의 캐시, 긴 오류 메시지 자르기. 실행 중의 미리보기 프레임을 싣는 이벤트는 없다(3-3·4-2에서 필요하면 더한다).

### 화면용 API — `@cs/api`

2-2에서 DreamVerse `@dv/api`를 옮겼다(`packages/api`, 호스트 절반만 있다). 서비스는 `ctx.csApi`이고 번들의 행은 `cs-api`다. 화면이 프로젝트를 읽고 바꾸는 유일한 길이다. 아래의 동작은 단위 시험과 조합 시험으로 확인했다(**띄워 확인**, 2026-11-28: 실제 dsh에 로그인한 브라우저 페이지에서 `fetch`와 `EventSource`로 불렀다).

| 경로 | 메서드 | 요청 | 응답 |
| --- | --- | --- | --- |
| `/api/cs/projects` | GET | — | `WireProject[]`(`{id, title, created_at, path}`), 최신순 |
| `/api/cs/projects` | POST | `{title, surface?}` 또는 `{folder, session}` | `ProjectInfo`. 앞의 것은 프로젝트 폴더 안에 새 폴더를 만들고, 뒤의 것은 채팅 세션의 폴더를 프로젝트로 만든다. 같은 제목이 있으면 번호를 붙인다 |
| `/api/cs/projects/untitled` | POST | `{name}` | `{path}`: 프로젝트 폴더 안의 새 빈 폴더(프로젝트가 없는 채팅이 쓸 폴더) |
| `/api/cs/projects/summary` | GET | `project?` | `WireProjectSummary[]`(`{project, cover, edited_at}`). 표지는 끝난 기록의 첫 이미지 출력이다 |
| `/api/cs/projects/rename` | POST | `{project, title}` | `{title}`(겹치면 ` 2`, ` 3` …) |
| `/api/cs/projects/delete` | POST | `{project}` | `{ok}`. 목록에서 빼고 폴더는 남긴다 |
| `/api/cs/state` | GET | `project` | `WireState`(`{project, head, tip, components, assets}`): 현재 위치 `head`, 히스토리의 끝 `tip`, 리듀서마다의 조각, 현재 상태가 가리키는 에셋 |
| `/api/cs/operations` | GET | — | `WireOperation[]`: `readOnly`가 아닌 연산의 선언(`name`, `label?`, `description`, `inputs`, `params`, `outputs` …) |
| `/api/cs/operation` | POST | `{project, operation, inputs?, params?, intent?, surface?, session?, based_on?, supersedes?}`. `inputs`는 `[{role, ref}]` | 기록(`ProjectRecord`). 끝났거나, 끝나지 않은 기록을 입력으로 받았으면 `pending` |
| `/api/cs/operation/check` | POST | 위와 같다 | `{problems}`. 아무것도 쓰지 않고, 지금 실행하면 거절될 문장을 준다 |
| `/api/cs/undo` | POST | `{project, to?}` | `{tip, at}`. `to`를 주면 그 단계로 간다 |
| `/api/cs/redo` | POST | `{project}` | `{tip, at}` |
| `/api/cs/stale/accept` | POST | `{project, record, session?, surface?}` | `proj.stale_accept` 기록 |
| `/api/cs/history` | POST | `{project, actor?, component?, operation?, kind?, status?, session?, turn?, tool_call?, records?, before?, limit?}` | `WireHistory`(`{entries, assets}`). `limit`은 1~200, 기본 50 |
| `/api/cs/proposal/decide` | POST | `{project, proposal, decision: "accept" \| "reject", surface?, session?}` | `{proposal, record}`: 결정 뒤의 제안과, 승인으로 실행된 연산의 기록(거절이거나 이미 결정된 제안이면 `null`). 2-3a |
| `/api/cs/catalog` | GET | — | `WireCatalogEntry[]`(`{primitive, provider, target, description, abilities, facts, problem}`): 카탈로그의 항목. 카탈로그가 없으면 `[]` |
| `/cs/events?project=<id>` | GET | — | `text/event-stream`: `ready` 뒤에 `record`(기록 추가), `update`(기록 갱신), `line`(현재 위치나 끝이 바뀜), `catalog`(카탈로그가 바뀜. 데이터 없음) |

- **쓰는 요청은 전부 프로젝트 계층의 연산 실행을 지난다.** `actor: "user"`로 부르고, 기록의 `surface`는 요청의 `surface`가 `chat`이면 `chat`, 그 밖은 `view`다. `session`을 주면 그 채팅 세션이 기록에 남는다.
- **오류**는 라우트와 스트림이 같은 본문 `{error, code, ...details}`로 답한다: `invalid_params`·`invalid_inputs`·`input_not_ready`·`read_only_operation`(400), `unknown_project`·`unknown_record`·`unknown_operation`·`unknown_asset`(404), 그 밖의 프로젝트 계층 거절(409. 예: `nothing_to_undo`, `proposal_busy`, `agent_not_allowed`), `internal_error`(500. 호스트 로그에도 남는다). 인증에서 걸린 요청(401·403)은 dsh가 답하는 꼴이라 이 본문이 아니다.
- 제목과 폴더 이름은 제어 문자가 없고 200바이트 이하여야 한다. 만들기는 한 번에 하나씩 처리되어 동시에 온 같은 제목도 서로 다른 번호를 받는다. 읽기 전용 연산은 이 API로 실행하지 못한다.
- **인증은 dsh의 것을 그대로 탄다.** fetch 라우트는 dsh `connection` 서비스의 정확 일치 라우트라, dsh가 Host·Origin과 브라우저 세션 쿠키를 검사한 뒤에 부르고 소유자만 닿는다. 이벤트 스트림은 `webServer`의 날 라우트라 요청마다 `connection.admit`으로 같은 검사를 하고 소유자일 때만 연다. `connection`이 없으면 스트림 라우트를 등록하지 않는다. 쿠키 없는 요청은 둘 다 401이다(**띄워 확인**). 플러그인이 내려가면 열린 스트림을 모두 끝내고(브라우저의 `EventSource`가 다시 잇는다), 읽지 않는 클라이언트의 버퍼가 4MiB를 넘어도 끝낸다.
- **화면은 상태를 들고 있지 않는다.** 스트림에 이벤트가 오면 `/api/cs/state`를 다시 읽는다. 상태는 통째로 온다(부분 갱신 라우트는 없다).
- **카탈로그**(2-1)는 있으면 읽는다. `@cs/api`는 카탈로그 서비스(`csCatalog`) 없이도 뜨고, 그때 `/api/cs/catalog`는 `[]`다. 카탈로그가 올라오거나 내려가거나 항목이 등록·해제되면 열린 스트림 모두에 `catalog` 이벤트가 간다(프로젝트와 무관하다). 화면은 그 이벤트에 목록을 다시 읽는다. 항목의 `problem`에는 프로바이더가 낸 오류 문장이 그대로 실리므로, 프로바이더는 그 문장에 키나 토큰이 든 주소를 넣지 않는다.
- **에셋**은 프로젝트 계층에 등록된 에셋 저장소에서 읽는다(`ctx.csProject.assets()`). 항목은 `{id, mime, name, url}`에 저장소가 아는 사실(`size_bytes`, `created_at`, `width`, `height`, `duration_sec`, `thumb_url`. 모르면 없다)이 붙은 것이고, 상태의 `assets`에는 `made_by`(만든 연산)가 붙는다. 상태의 `assets`는 현재 상태의 기록이 가리키는 것, 대기 중인 제안의 입력, 그리고 조각이 가리키는 것(`Reducer.mentions`. 가져온 에셋은 히스토리 밖이라 기록에 없다)이다. 에셋 기능 컴포넌트가 없으면 빈 저장소라 늘 `[]`이다.
- 브라우저가 받는 JSON의 타입은 `@cs/api/wire`에 있다(`WireState`, `WireHistory`, `WireProject`, `ProjectAsset`, `WireCatalogEntry`). 브라우저 절반은 `import type`으로 가져다 쓴다(**띄워 확인**, 2026-11-28: `@cs/ui-shell`의 브라우저 프로그램이 `WireProject`를 가져와 타입 검사된다). 이 모듈은 프로젝트 계층의 타입 전용 진입점(`@cs/project/types`)만 가져온다. 연산 선언의 타입 `WireOperation`은 `packages/api/src/wire-operation.ts`에 따로 있다. dsh의 도구 타입을 쓰는데, 그것을 브라우저 프로그램에 들이면 dsh의 호스트 선언이 따라와 `ctx.sessions`의 타입을 덮는다(`docs/DSH.md` "타입을 얻는 패키지"). 브라우저에서 연산 선언을 타입으로 쓰는 법은 실행 폼을 만드는 3-3에서 정한다.
- 설정(번들의 `cs-api` 행): `keepaliveMs`(15000, 1000 이상. 스트림이 조용할 때 주석 줄을 보내는 간격).

DreamVerse의 라우트 가운데 아직 없는 것과 생길 곳:

| DreamVerse 경로 | 하는 일 | 우리 쪽 |
| --- | --- | --- |
| `/api/dv/assets/import`, `/dv/assets` | 에셋 가져오기, 파일 내려주기 | 2-3b에서 `@cs/asset`의 `/api/cs/asset/upload`와 `/api/cs/asset`으로 만들었다(화면용 API가 아니라 에셋 기능 컴포넌트의 라우트다) |
| `/api/dv/models`, 스트림의 `models` 이벤트 | 카탈로그 | 2-1에서 `/api/cs/catalog`와 `catalog` 이벤트로 만들었다 |
| `/api/dv/tasks` | 작업 이름의 표시 글 | 가져오지 않는다. 우리 카탈로그에는 작업 구분이 없다 |
| `/api/dv/skills`, `/api/dv/skills/upload` | 스킬 묶음 업로드 | 가져오지 않는다. 스킬은 dsh의 스킬 폴더에 맡긴다(1-4) |

## 화면 구조

DreamVerse처럼 기본 dsh 화면을 교체한다. 3-0에서 셸을 만들었다(`packages/ui-shell`의 브라우저 절반, 2026-11-28). 방법과 dsh 쪽 사실은 `docs/DSH.md` "화면 교체"에, 설계는 `docs/archive/PLAN_3-0.md`에 있다.

```
┌ 왼쪽 사이드바(dsh) ──┬ 가운데(우리) ────────────────────┬ 우측 패널(dsh) ─────┐
│ ComfyStudio          │ 홈: 프로젝트 카드, 새 프로젝트    │ [채팅] [+]          │
│ [+ 새 프로젝트]      │   또는                            │                     │
│ Plugins …(dsh)       │ 프로젝트 틀:                      │ dsh의 대화 화면과   │
│ 홈                   │   위쪽 줄(이름, 화면 탭, 채팅)    │ 입력창              │
│ 프로젝트             │   cs.center.view에 등록된 화면    │                     │
│ ▾ 프로젝트 A    ⋯ +  │   (3-2의 갤러리가 꽂힌다)         │                     │
│     채팅 1           │                                   │                     │
│ 설정(dsh)            │                                   │                     │
└──────────────────────┴───────────────────────────────────┴─────────────────────┘
```

| 영역                              | 그리는 쪽 | 방법                                                                                   | 확인(dsh 0.2.2-rc.5)                     |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| 브랜드(이름 ComfyStudio, 임시 마크) | 우리    | 슬롯 `sidebar.brand.name`·`sidebar.brand.mark`에 `priority: -1`                        | 띄워 확인(조합 시험)                     |
| "새 프로젝트" 버튼                | 우리      | `hoc` 슬롯 `sidebar.session.action`(dsh의 새 세션 버튼 자리)                           | 띄워 확인(조합 시험)                     |
| 내비게이터(홈, 프로젝트, 채팅 세션) | 우리    | 슬롯 `sidebar.workspaces`에 `priority: -1`                                             | 띄워 확인(조합 시험)                     |
| 패널 목록(Plugins 등), 설정, 3단 프레임, 모델 선택 | dsh | 그대로 둔다                                                                    | —                                        |
| 가운데의 홈과 프로젝트 틀         | 우리      | 슬롯 `main.conversation`에 `priority: -1`                                              | 띄워 확인(조합 시험)                     |
| 프로젝트 틀 안의 화면             | 화면 패키지 | 셸이 선언한 자식 슬롯 `cs.center.view`(list)에 `id`·`order`·`label`로 등록한다. 틀이 `{ projectId, sessionId }`를 넘긴다. 둘 이상이면 틀이 탭을 그린다 | 띄워 확인(화면 둘을 임시로 등록해 봤다). 등록하는 패키지는 아직 없다(3-2) |
| 채팅 본문과 입력창                | dsh       | 우측 패널의 탭 `cs-chat` 안에서 Factory 슬롯 `conversation.content`로 그린다            | 입력창에 글을 쓰는 데까지 띄워 확인(조합 시험). 메시지가 오가는 것은 미확인(1-3) |
| 우측 패널의 다른 탭               | 우리      | `ctx.sidebarRightTabs.register` + 슬롯 `sidebar.right.pane.tab`                        | 띄워 확인                                |
| 실패 알림                         | 우리      | 슬롯 `shell.overlay`에 dsh의 `Toast`                                                    | 띄워 확인(조합 시험: 화면용 API의 거절)  |
| 채팅 안의 카드(도구 결과, 제안)   | 우리      | 슬롯 `conversation.chat.node`, `tool.call.toolview`, `conversation.chat.turnTail`      | 소스 확인(슬롯이 있다). 그려 보지 않았다(3-4) |
| 설정 항목(ComfyUI 서버 등록 등)   | 우리      | 슬롯 `settings.section` 등                                                             | 소스 확인(슬롯이 있다). 그려 보지 않았다(3-5) |

셸의 규칙(3-0. 사용자가 정한 것과 Claude가 고른 것은 `docs/DECISIONS.md`에 나눠 적었다):

- **프로젝트 하나에 채팅 세션이 여럿이다.** 프로젝트는 dsh 작업공간이고 그 작업공간의 세션이 프로젝트의 채팅이다. 내비게이터에서 프로젝트 아래에 채팅 목록을 둔다.
- **채팅은 프로젝트 안에서만, 우측 패널 한 곳에만 그린다.** 홈에는 채팅이 없다: 홈으로 가면 우측 패널을 접는다. 패널 자체는 dsh의 것이라 숨기지는 않는다(숨기려면 장치가 하나 더 든다. `docs/DSH.md` "확인하지 못한 것"). 같은 세션의 대화를 두 곳에 그리지 않는다(`docs/DSH.md` "채팅을 우측 탭으로 옮기는 코드").
- **열린 프로젝트는 dsh의 주 세션을 따른다.** 프로젝트를 열면 주 세션을 그 프로젝트의 세션으로 옮기고, 주 세션이 다른 프로젝트의 세션이 되면 그 프로젝트가 열린다. 위치는 URL에 적지 않는다. 새로고침하면 dsh가 주 세션을 되살리고 프로젝트가 따라온다.
- **저장된 상태가 없는 브라우저는 홈에서 시작한다**(사용자가 정했다, 2026-11-28). 새 기기나 시크릿 창으로 열면 dsh는 마지막 프로젝트의 새 빈 세션을 주 세션으로 삼는데, 셸이 그 첫 복원만은 따르지 않고 홈에 머문다. 프로젝트를 누르면 그 프로젝트의 가장 최근 대화가 열린다. 처음 온 브라우저인지는 셸이 자기 표시(localStorage)로 가린다. dsh의 저장 값은 읽지 않는다.
- **프로젝트 목록은 화면용 API에서 읽는다**(`GET /api/cs/projects`). dsh의 작업공간 목록이 바뀔 때마다 다시 읽는다. 만들기·이름 바꾸기·빼기도 화면용 API를 부른다. 셸은 프로젝트의 내용(기록, 상태)을 읽지 않는다.
- **dsh 내부에 기대는 장치는 둘이고 한 파일에 있다**(`packages/ui-shell/src/client/chrome.ts`): 첫 실행의 기본 작업공간 자동 생성을 막는 것, 브랜드를 눌러 새 세션이 열리는 것을 막는 것(`docs/DSH.md` "dsh 내부에 기대는 장치").
- 브라우저 탭 제목과 파비콘은 dsh의 것 그대로다.

## dsh가 맡는 것과 우리가 만드는 것

| dsh가 맡는다                                              | 우리가 만든다                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| LLM 프로바이더와 모델 설정, 자격 증명                     | 프로젝트 계층(기록, 히스토리, 상태)                                  |
| 대화(세션), 메시지 표시, 입력창, 첨부                     | 기능 컴포넌트(에셋, 워크플로, 생성·배치, 캐릭터 …)                   |
| 도구 호출 루프, 승인, 권한                                | Comfy 연결(서버 종류별 클라이언트, 실행, 결과 수집)                  |
| MCP, 스킬, 서브에이전트, 예약 실행, 페이지 가져오기       | 가운데 화면과 우리 탭, 채팅 안의 카드                                |
| 웹 서버, 원격 접속, 설정 화면                             | 작업 절차를 적은 스킬, 우리 에이전트 프리셋, 웹 검색 백엔드를 꽂는 플러그인 |

기존 기능 하나하나가 어디로 가는지는 `docs/LEGACY.md` "대응표"에 있다. dsh가 맡는 항목은 1-3과 1-4에서 써 봤다(`docs/DSH.md` "dsh가 이미 주는 기능").

## 데이터가 사는 곳

| 데이터                                                    | 자리                                                                                                              | 상태                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 프로젝트 내용(에셋, 생성, 배치, 검토 결과 …)              | 프로젝트 폴더 안의 기록 파일 `<프로젝트 폴더>/.comfy-studio/records.jsonl`·`line.json`과 에셋 파일                 | 기록은 2-0에서, 에셋 파일(`.comfy-studio/assets/`)은 2-3b에서 만들었다 |
| 프로젝트 자체                                             | dsh 작업공간(등록된 폴더) 하나가 프로젝트 하나다. 기록 디렉터리가 있는 작업공간이 프로젝트다. 새 프로젝트의 폴더는 `<사용자 홈>/comfy-studio-projects/<이름>`(`CS_PROJECTS_FOLDER`로 바꾼다) | 2-0에서 만들었다. 목록은 dsh 작업공간 등록부(home 안)에 있고 파일은 home 밖에 있다 |
| 대화(세션 로그)                                           | dsh(`$DSH_HOME`)                                                                                                  | dsh. 프로젝트 하나에 세션을 여럿 둔다(3-0) |
| LLM 프로바이더·모델 설정                                  | dsh(프로필의 `cordis.patch.yml`)                                                                                  | dsh                                    |
| 비밀값                                                    | dsh 자격 증명 저장소(`$DSH_HOME/.credentials.yaml`). 설정에는 참조만 둔다.                                         | dsh. 플러그인에서 쓰는 법은 미확인(4-1) |
| ComfyUI 서버 목록, 서버별 모델 파일 목록                  | 미정                                                                                                              | 설계 과제(4-1)                         |
| 워크플로 템플릿, 캐릭터                                   | 프로젝트의 기록이다(프로젝트마다 따로). 다른 프로젝트의 것을 복사해 오는 연산을 둔다. 워크플로의 그래프는 에셋 저장소의 JSON 블롭이다 | 사용자가 정했다(2026-11-28). 워크플로는 2-3c에서 만들었다. 캐릭터는 2-3e |
| 프리셋(에이전트의 규칙과 메모)                            | 프로젝트 밖, dsh home의 저장소. 모든 프로젝트에 적용된다                                                          | 사용자가 정했다(2026-11-28). 저장소의 모양은 2-3f |

개발용 `DSH_HOME`은 본 체크아웃의 `.dsh-home` 하나이고 모든 워크트리가 같이 쓴다(`docs/DSH.md` "워크트리와 DSH_HOME").

## 접속과 배포

1-5에서 띄워 보고 정했다(2026-11-28). 사실마다의 확인 수준은 `docs/DSH.md` "리버스 프록시와 로그인"에 있다. 이 저장소는 공개이므로 실제 서버의 구성은 적지 않는다. 아래의 호스트 이름은 예시다.

**권하는 구성**(사용자가 정했다, `docs/DECISIONS.md` "확정"): 리버스 프록시가 TLS를 끝내고 **자체 인증을 건 뒤** 루프백의 dsh로 넘긴다. dsh의 로그인(토큰 주소와 쿠키)은 그 뒤에 그대로 있다. 방어선이 둘이다.

```
브라우저 ──HTTPS──▶ 리버스 프록시(TLS + 프록시 쪽 인증) ──HTTP──▶ dsh 127.0.0.1:3080
```

dsh 쪽:

```sh
DSH_HOME=<남겨 둘 경로> pnpm dsh:start --no-open --port 3080 \
  --trusted-host studio.example.com --public-url https://studio.example.com/
```

- **`--trusted-host`가 꼭 있어야 한다.** 없으면 페이지만 열리고 `/api/*`와 `/cs/events`가 403이다. `--public-url`은 출력되는 로그인 주소를 그 출처로 만들어 줄 뿐이다(없으면 루프백 주소로 찍힌다).
- `--host`는 주지 않는다. dsh는 루프백에서만 듣고, 그 포트는 프록시만 닿게 둔다.
- `DSH_HOME`은 지워지지 않는 경로로 준다. 설정, 세션, 쿠키의 서명 비밀이 거기 있다. 주지 않으면 체크아웃의 `.dsh-home`이다.
- `pnpm dsh:start`는 띄울 때마다 프로필을 맞추고 브라우저 번들을 빌드한다. 서비스로 돌릴 때 빌드를 미리 해 두고 dsh만 띄우는 구성은 해 보지 않았다(**미확인**).

프록시가 지킬 것(넷 다 조합 시험이나 실험으로 봤다):

1. 브라우저의 `Host`를 그대로 넘긴다. 업스트림 주소로 바꾸면 dsh가 403으로 거절한다.
2. WebSocket 업그레이드를 전달한다(`Upgrade`, `Connection`). dsh의 실시간 채널이 WebSocket이다.
3. 응답을 버퍼링하지 않고 읽기 시간 제한을 넉넉히 둔다. 이벤트 스트림(`/cs/events`)과 WebSocket이 오래 열려 있다.
4. 호스트 이름의 뿌리에 올린다. 경로 접두사 아래에는 올리지 않는다(우리 화면이 `/api/cs/…`를 절대 경로로 부른다).

nginx의 예(TLS와 `auth_basic` 줄을 뺀 나머지는 nginx 1.27에서 돌려 봤다. 그 두 부분은 **미확인**):

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
  listen 443 ssl;
  server_name studio.example.com;
  ssl_certificate     /etc/ssl/studio.example.com/fullchain.pem;
  ssl_certificate_key /etc/ssl/studio.example.com/privkey.pem;
  auth_basic           "studio";                  # 프록시 쪽 인증
  auth_basic_user_file /etc/nginx/studio.htpasswd;
  client_max_body_size 300m;                      # dsh의 요청 본문 한도(기본 300 MiB)에 맞춘다
  location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;             # 브라우저의 Host 그대로
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1h;                        # WebSocket과 이벤트 스트림
  }
}
```

Caddy의 예(`reverse_proxy` 한 줄은 Caddy 2.8에서 돌려 봤다. 인증서 발급과 `basic_auth`는 **미확인**):

```caddy
studio.example.com {
  basic_auth {
    <사용자> <caddy hash-password로 만든 해시>
  }
  reverse_proxy 127.0.0.1:3080
}
```

로그인:

- 기기마다 프록시 쪽 인증을 한 번, dsh의 로그인 주소(토큰이 든 주소)를 한 번 연다. 그 뒤로는 쿠키가 30일 동안 유효하다. 비밀번호 로그인은 dsh에 없다.
- dsh를 다시 띄우면 토큰은 바뀌지만, 같은 home과 같은 주소면 이미 받은 쿠키는 그대로 유효하다. 새 로그인 주소가 필요한 것은 새 기기와 쿠키가 만료된 기기뿐이다.
- **로그인 주소는 dsh의 표준 출력에 찍힌다.** 서비스로 돌리면 그 줄이 서비스 로그에 남는다. 표준 출력을 읽을 수 있는 사람을 제한한 곳으로 보내고, 주소를 문서·채팅·이슈에 붙이지 않는다.
- 접속 주소는 하나로 정해 쓴다. 쿠키도 브라우저에 저장되는 화면 상태도 주소마다 따로다.
- 저장된 상태가 없는 브라우저(새 기기, 시크릿 창)는 홈에서 시작한다("화면 구조"의 셸의 규칙).

다른 길: 사설망 안에서만 쓸 때는 프록시 없이 dsh가 직접 TLS로 듣거나(`--tls-cert`, `--tls-key`) `--host <사설 주소>`로 평문으로 열 수 있다(둘 다 실험으로 봤다). 평문에서는 토큰이 그대로 오간다.

확인한 범위: 조합 시험 `tests/integration/proxy.test.ts`가 dsh 앞에 시험용 프록시를 두고 다른 호스트 이름으로 접속해 로그인, 프로젝트 만들기, 채팅, 이벤트 스트림, WebSocket을 본다. 실제 인증서와 실제 다른 기기로 하는 확인은 배포하는 쪽에 남는다(**미확인**).

## 패키지 구성(가칭)

이름과 나누는 단위는 계획 1·2에서 확정한다. 스코프는 `@cs/*`다.

```
packages/
  bundle/            @cs/bundle        cordis.patch.yml의 행 모음(프로필 계층), 에이전트 프리셋
  project/           @cs/project       프로젝트 계층(2-0)
  api/               @cs/api           화면용 API(2-2)
  catalog/           @cs/catalog       카탈로그 계약(2-1): 계약 타입, 서비스 ctx.csCatalog, 시험용 가짜 생성 프로바이더
  comfy/             @cs/comfy         ComfyUI 연동 라이브러리(4-0): 서버 종류별 클라이언트, 그래프와 패치, 프로토콜, 모델 계열. dsh에 의존하지 않는다. 플러그인이 아니라 번들의 행이 없다
  comfy-provider/    카탈로그에 등록하는 생성 프로바이더, 실행기
  asset/             @cs/asset         에셋 기능 컴포넌트(2-3b): 저장소, 라이브러리의 리듀서와 연산, 파일 라우트
  ffmpeg/            @cs/ffmpeg        ffmpeg·ffprobe를 실행하는 서비스 ctx.csFfmpeg(2-3b). 연산이 없다
  workflow/          @cs/workflow      워크플로 기능 컴포넌트(2-3c): 그래프 템플릿과 필드, 패치를 변형으로 저장, 읽기 도구
  <이름>/            기능 컴포넌트 하나에 패키지 하나
  ui-kit/            자체 부품과 화면 공용 브라우저 코드
  ui-shell/          셸(브랜드, 내비게이터, 가운데 틀, 우측 탭)
  ui-<이름>/         화면 하나에 패키지 하나
scripts/             프로필 만들기, 실행, 합성 구성 찍기(`dsh.ts`, `dsh-env.ts`)
```

## 설계 과제

| 과제                                                                                  | 정하는 단계 |
| ------------------------------------------------------------------------------------- | ----------- |
| 재시작 후 실행 이어받기(프로젝트 계층은 재시작 때 끝나지 않은 기록을 끝낸다)          | 4-2         |
| 카탈로그를 읽는 에이전트 도구                                                         | 2-3         |
| 배치를 기록과 리듀서로 옮기는 모양(폴더, 태그, 검토 상태는 2-3b에서 옮겼다)           | 2-3d        |
| ComfyUI 서버 목록과 서버별 모델 목록의 자리                                           | 4-1         |
| 프리셋 저장소의 모양(dsh 저장소 도메인), 프리셋 변경의 제안이 프로젝트 계층의 장치를 쓸지 | 2-3f        |
| 자체 부품의 범위와 디자인 문서                                                        | 3-1         |
| 브라우저에서 연산 선언(`WireOperation`)을 타입으로 쓰는 법                            | 3-3         |
| ComfyUI 서버 키를 dsh 자격 증명에 두는 법                                             | 4-1         |
