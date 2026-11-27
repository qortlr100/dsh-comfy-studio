# 아키텍처

만들 구조를 적는다. 만들어진 것은 프로젝트 계층(2-0, 2026-11-27)과 화면용 API(2-2, 2026-11-28)뿐이므로 각 절에서 **정해진 것**과 **설계 과제**를 구분한다. 근거가 된 조사는 `docs/DSH.md`·`docs/DREAMVERSE.md`·`docs/LEGACY.md`에, 결정의 출처는 `docs/DECISIONS.md`에, 만드는 순서는 `docs/ROADMAP.md`에 있다. 낱말의 뜻은 `AGENTS.md` "용어"를 따른다.

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
| 에셋 | `registerAssetStore(store)`: 에셋 기능 컴포넌트(2-3)가 등록한다. 그때까지는 아무 에셋도 없는 빈 저장소가 대신한다. 프로젝트 계층 밖에서 읽을 때는 `assets()`(`has`·`get`·`url`만 있다. 화면용 API가 쓴다) |

- `origin`은 누가(`actor`: `user`·`agent`·`system`), 어디서(`surface`: `chat`·`view`·`api`·`history`), 어느 세션·턴·도구 호출에서, 왜(`intent`) 했는지다. 기록마다 남는다. `view`는 우리 화면에서 한 사용자 동작이다.
- 프로젝트 폴더의 `.comfy-studio/`에 `records.jsonl`(기록 줄과 갱신 줄, 추가만 한다)과 `line.json`(히스토리의 끝 `tip`과 현재 위치 `at`)이 있다. 이 디렉터리는 프로젝트 계층만 읽고 쓴다.
- 에이전트에게 가는 것: 연산마다의 도구 `cs_<연산 이름>`, 프로젝트 도구 여덟 개(`cs_proj_create`, `_rename`, `_state`, `_history_list`, `_undo`, `_redo`, `_stale_accept`, `_wait`), 시스템 프롬프트의 `cs:project` 절(규칙만), 대화에 덧붙는 프로젝트 상태 메시지와 갱신 메시지. 도구가 에이전트의 목록에 실제로 들어가는지와 메시지가 턴에 붙는지는 모델 키가 없어 **미확인**이다(1-3).
- 설정(번들의 `cs-project` 행): `projectsFolder`(새 프로젝트 폴더를 둘 곳. 환경 변수 `CS_PROJECTS_FOLDER`에서 읽고, 없거나 비어 있으면 `<사용자 홈>/comfy-studio-projects`), `cpuConcurrency`(4), `gpuConcurrency`(1), `promptSectionOrder`(4900).
- 프로젝트 규칙 절은 DreamVerse의 것을 뜻 그대로 옮겼다("모든 호출은 바로 히스토리의 단계다. 사용자가 변경을 승인하지 않는다"). 기존 앱의 "제안 후 승인"(삭제, 그래프 패치)과 맞추는 일은 기능 컴포넌트를 만드는 2-3에서 한다.

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
- 에이전트가 그 밖에 무엇을 가질지는 **에이전트 프리셋**이 정한다. dsh의 기본 프리셋(`standard`)은 셸과 파일 도구를 준다(`docs/DSH.md` "에이전트 프리셋"). 이 도구가 있으면 에이전트가 기록을 거치지 않고 프로젝트 폴더를 고치거나 지울 수 있어서, "프로젝트를 바꾸는 길은 연산 실행 하나"와 "에이전트는 직접 지우지 않는다"가 도구 수준에서는 보장되지 않는다.
- DreamVerse는 자기 프리셋을 기본으로 두고 셸·파일 도구를 넣지 않았다. 우리 번들도 자기 프리셋을 가진다. **그 안에 무엇을 넣을지는 미정이다**(1-4, `docs/DECISIONS.md`). 프로젝트 문서를 작업공간의 파일로 다루는 안(`docs/LEGACY.md` "대응표")은 파일 도구가 있어야 하므로 이 결정에 달려 있다.

## 두 계약

계획 2가 먼저 정해야 하는 것이다. 이 둘이 정해져야 계획 3(화면)과 계획 4(Comfy 연결)가 따로 갈 수 있다. 화면용 API는 2-2에서 만들었다. **카탈로그 계약은 아직 설계하지 않았다.**

### 카탈로그 계약

생성 프로바이더가 꽂히는 자리다. DreamVerse의 카탈로그 항목은 `(modality, task, provider, model)` 열쇠와 `facts()`·`schema()`·`validateGenerationRequest()`·`render()`를 가진다. 요청은 프롬프트와 참조 에셋 모양이다(`prompt`, `references`, `firstFrame`, `lastFrame`, 크기·길이, `seed`, `extra`). ComfyUI는 이 모양이 아니다. 그래서 이 계약은 가져오지 못하고 새로 정한다. 다만 DreamVerse 카탈로그는 선언 병합으로 새 요청 종류를 받게 되어 있어서(image, audio가 그렇게 추가됐다) 틀은 쓸 수 있다.

계약이 담아야 하는 것(기존 앱이 이미 하는 일이다):

- **요청**: API 형식 그래프(템플릿), 선택적인 그래프 패치, 필드 값, 입력 에셋 참조(실행 직전에 서버의 input 폴더로 복사한다), 대상 서버.
- **실행**: 제출 → 진행률(노드, 값, 최대) → 완료 판정(폴링이 기준이고 WebSocket은 보조다) → 출력 파일 여러 개(이미지, 영상, 오디오) → 바이트를 받아 에셋으로 저장.
- **취소**: 결과가 셋이다(`canceled`, `running`, `finished`).
- **보내기 전 검증**: 그래프 검증과 서버별 준비 점검(빠진 노드, 없는 모델 파일).
- **서버 조회**: 시스템 상태, 노드 카탈로그, 모델 파일 목록과 메타데이터, 서버의 실행 기록. 서버 종류마다 되는 것이 다르다.
- **재시작 후 이어받기**: 진행 중이던 실행을 다시 추적한다.

설계할 때 답해야 하는 질문:

1. 카탈로그 항목 하나는 무엇인가. 서버 하나인가, 서버와 워크플로 템플릿의 짝인가.
2. 요청에 그래프 전체를 싣는가, 템플릿 id + 패치 + 필드 값을 싣는가. 어느 쪽이든 기록에는 실제로 보낸 그래프가 남아야 한다.
3. 결과는 스트림인가, 출력 파일 목록인가. 진행률·취소·이어받기는 카탈로그와 기능 컴포넌트 중 어디에 속하는가.
4. 서버 조회는 카탈로그 항목의 `facts`·`schema`에 넣는가, 별도 서비스로 두는가.
5. 기존 `ComfyBackend` 인터페이스(네 서버 종류에서 이미 쓰이고 있다)를 카탈로그 아래의 내부 인터페이스로 그대로 둘 수 있는가.
6. 기존 규칙 "`/prompt` 검증 실패는 기록을 남기지 않는다"를 어떻게 지키는가. 위 흐름에서는 `pending` 기록이 구현 실행(서버 제출)보다 먼저 추가된다. 서버 검증을 사전 조건 단계로 올릴지, 제출 전에 실패한 기록을 실행으로 세지 않을지를 정한다.

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
| `/cs/events?project=<id>` | GET | — | `text/event-stream`: `ready` 뒤에 `record`(기록 추가), `update`(기록 갱신), `line`(현재 위치나 끝이 바뀜) |

- **쓰는 요청은 전부 프로젝트 계층의 연산 실행을 지난다.** `actor: "user"`로 부르고, 기록의 `surface`는 요청의 `surface`가 `chat`이면 `chat`, 그 밖은 `view`다. `session`을 주면 그 채팅 세션이 기록에 남는다.
- **오류**는 라우트와 스트림이 같은 본문 `{error, code, ...details}`로 답한다: `invalid_params`·`invalid_inputs`·`input_not_ready`·`read_only_operation`(400), `unknown_project`·`unknown_record`·`unknown_operation`·`unknown_asset`(404), 그 밖의 프로젝트 계층 거절(409. 예: `nothing_to_undo`), `internal_error`(500. 호스트 로그에도 남는다). 인증에서 걸린 요청(401·403)은 dsh가 답하는 꼴이라 이 본문이 아니다.
- 제목과 폴더 이름은 제어 문자가 없고 200바이트 이하여야 한다. 만들기는 한 번에 하나씩 처리되어 동시에 온 같은 제목도 서로 다른 번호를 받는다. 읽기 전용 연산은 이 API로 실행하지 못한다.
- **인증은 dsh의 것을 그대로 탄다.** fetch 라우트는 dsh `connection` 서비스의 정확 일치 라우트라, dsh가 Host·Origin과 브라우저 세션 쿠키를 검사한 뒤에 부르고 소유자만 닿는다. 이벤트 스트림은 `webServer`의 날 라우트라 요청마다 `connection.admit`으로 같은 검사를 하고 소유자일 때만 연다. `connection`이 없으면 스트림 라우트를 등록하지 않는다. 쿠키 없는 요청은 둘 다 401이다(**띄워 확인**). 플러그인이 내려가면 열린 스트림을 모두 끝내고(브라우저의 `EventSource`가 다시 잇는다), 읽지 않는 클라이언트의 버퍼가 4MiB를 넘어도 끝낸다.
- **화면은 상태를 들고 있지 않는다.** 스트림에 이벤트가 오면 `/api/cs/state`를 다시 읽는다. 상태는 통째로 온다(부분 갱신 라우트는 없다).
- **에셋**은 프로젝트 계층에 등록된 에셋 저장소에서 읽는다(`ctx.csProject.assets()`). 항목은 `{id, mime, name, url}`이고 상태의 `assets`에는 `made_by`(만든 연산)가 붙는다. 에셋 기능 컴포넌트(2-3)가 생기기 전에는 빈 저장소라 늘 `[]`이다.
- 브라우저가 받는 JSON의 타입은 `@cs/api/wire`에 있다(`WireState`, `WireOperation`, `WireHistory`, `WireProject`, `ProjectAsset`). 브라우저 절반은 `import type`으로 가져다 쓴다.
- 설정(번들의 `cs-api` 행): `keepaliveMs`(15000, 1000 이상. 스트림이 조용할 때 주석 줄을 보내는 간격).

DreamVerse의 라우트 가운데 아직 없는 것과 생길 곳:

| DreamVerse 경로 | 하는 일 | 우리 쪽 |
| --- | --- | --- |
| `/api/dv/assets/import`, `/dv/assets` | 에셋 가져오기, 파일 내려주기 | 에셋 기능 컴포넌트와 함께(2-3) |
| `/api/dv/models`, `/api/dv/tasks`, 스트림의 `models` 이벤트 | 카탈로그 | 카탈로그 계약이 정해진 뒤(2-1 이후) |
| `/api/dv/skills`, `/api/dv/skills/upload` | 스킬 묶음 업로드 | 가져오지 않는다. 스킬 관리를 dsh에 맡길지는 1-4가 정한다 |

## 화면 구조

DreamVerse처럼 기본 dsh 화면을 교체한다. 방법과 확인 결과는 `docs/DSH.md` "화면 교체"에 있다. 아래의 "띄워 확인"은 그 장치가 0.2.2-rc.5에서 동작한다는 뜻이다. 확인에 쓴 코드는 업스트림의 브라우저 코드 규칙을 따르지 않은 시험용이었다. 규칙대로 쓴 형태(`inject`, `hooks`)는 1-1에서 띄워 확인했다(`docs/DSH.md` "슬롯").

| 영역                              | 그리는 쪽 | 방법                                                                                   | 확인(dsh 0.2.2-rc.5)                     |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| 브랜드                            | 우리      | 슬롯 `sidebar.brand.name`·`sidebar.brand.mark`에 `priority: -1`                        | 띄워 확인                                |
| 왼쪽 사이드바의 프로젝트 목록     | 우리      | 슬롯 `sidebar.workspaces`에 `priority: -1`(사이드바 전체는 슬롯 `sidebar`)             | 띄워 확인                                |
| 가운데                            | 우리      | 슬롯 `main.conversation`에 `priority: -1`                                              | 띄워 확인                                |
| 채팅 본문과 입력창                | dsh       | 우측 패널 탭 안에서 Factory 슬롯 `conversation.content`로 다시 그린다                  | 입력창에 글을 쓰는 데까지 띄워 확인. 메시지가 오가는 것은 미확인(1-3) |
| 우측 패널의 다른 탭               | 우리      | `ctx.sidebarRightTabs.register` + 슬롯 `sidebar.right.pane.tab`                        | 띄워 확인                                |
| 3단 프레임, 설정 화면, 모델 선택  | dsh       | 그대로 둔다                                                                            | —                                        |
| 채팅 안의 카드(도구 결과, 제안)   | 우리      | 슬롯 `conversation.chat.node`, `tool.call.toolview`, `conversation.chat.turnTail`      | 소스 확인(슬롯이 있다). 그려 보지 않았다(3-4) |
| 설정 항목(ComfyUI 서버 등록 등)   | 우리      | 슬롯 `settings.section` 등                                                             | 소스 확인(슬롯이 있다). 그려 보지 않았다(3-5) |

화면에 쓸 제품 이름과 마크, 숨길 기본 요소, 프로젝트 하나에 둘 세션 수는 정해지지 않았다(3-0, `docs/DECISIONS.md` "미정").

## dsh가 맡는 것과 우리가 만드는 것

| dsh가 맡는다                                              | 우리가 만든다                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| LLM 프로바이더와 모델 설정, 자격 증명                     | 프로젝트 계층(기록, 히스토리, 상태)                                  |
| 대화(세션), 메시지 표시, 입력창, 첨부                     | 기능 컴포넌트(에셋, 워크플로, 생성·배치, 캐릭터 …)                   |
| 도구 호출 루프, 승인, 권한                                | Comfy 연결(서버 종류별 클라이언트, 실행, 결과 수집)                  |
| MCP, 스킬, 서브에이전트, 예약 실행                        | 가운데 화면과 우리 탭, 채팅 안의 카드                                |
| 웹 서버, 원격 접속, 설정 화면                             | 작업 절차를 적은 스킬, 우리 에이전트 프리셋                          |

기존 기능 하나하나가 어디로 가는지는 `docs/LEGACY.md` "대응표"에 있다. dsh가 맡는 항목 대부분은 패키지와 문서로만 확인했다. 실제로 써 보는 것은 1-3과 1-4의 일이다.

## 데이터가 사는 곳

| 데이터                                                    | 자리                                                                                                              | 상태                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 프로젝트 내용(에셋, 생성, 배치, 검토 결과 …)              | 프로젝트 폴더 안의 기록 파일 `<프로젝트 폴더>/.comfy-studio/records.jsonl`·`line.json`과 에셋 파일                 | 기록은 2-0에서 만들었다. 에셋 파일은 2-3 |
| 프로젝트 자체                                             | dsh 작업공간(등록된 폴더) 하나가 프로젝트 하나다. 기록 디렉터리가 있는 작업공간이 프로젝트다. 새 프로젝트의 폴더는 `<사용자 홈>/comfy-studio-projects/<이름>`(`CS_PROJECTS_FOLDER`로 바꾼다) | 2-0에서 만들었다. 목록은 dsh 작업공간 등록부(home 안)에 있고 파일은 home 밖에 있다 |
| 대화(세션 로그)                                           | dsh(`$DSH_HOME`)                                                                                                  | dsh. 프로젝트 하나에 둘 세션 수는 미정(3-0) |
| LLM 프로바이더·모델 설정                                  | dsh(프로필의 `cordis.patch.yml`)                                                                                  | dsh                                    |
| 비밀값                                                    | dsh 자격 증명 저장소(`$DSH_HOME/.credentials.yaml`). 설정에는 참조만 둔다.                                         | dsh. 플러그인에서 쓰는 법은 미확인(4-1) |
| ComfyUI 서버 목록, 서버별 모델 파일 목록                  | 미정                                                                                                              | 설계 과제(4-1)                         |
| 프로젝트를 넘는 것(캐릭터 라이브러리, 프리셋)             | 미정                                                                                                              | 설계 과제(2-3)                         |

개발용 `DSH_HOME`은 본 체크아웃의 `.dsh-home` 하나이고 모든 워크트리가 같이 쓴다(`docs/DSH.md` "워크트리와 DSH_HOME").

## 접속과 배포

- dsh 웹은 기본으로 loopback 포트에서 듣는다(기본 포트 3080, `--host`·`--port`로 바꾼다).
- 다른 기기에서 쓰려면 리버스 프록시 뒤에 두고 `--public-url`과 `--trusted-host`를 준다. 프록시는 `Host`를 그대로 넘기고, 업그레이드 요청을 전달해야 한다.
- 로그인은 실행 때 출력되는 주소에 든 토큰을 세션 쿠키로 바꾸는 방식이다. 비밀번호 로그인은 없다. 출력된 주소는 자격 증명이므로 비밀로 다룬다.
- 이 저장소의 배포 구성은 1-5에서 정한다.

출처는 업스트림 `docs/user/guide/public-deployments.md`다(소스 확인). 직접 배포해 보지는 않았다.

## 패키지 구성(가칭)

이름과 나누는 단위는 계획 1·2에서 확정한다. 스코프는 `@cs/*`다.

```
packages/
  bundle/            @cs/bundle        cordis.patch.yml의 행 모음(프로필 계층), 에이전트 프리셋
  project/           @cs/project       프로젝트 계층(2-0)
  api/               @cs/api           화면용 API(2-2)
  catalog/           카탈로그 계약(타입과 서비스 정의)
  comfy/             @cs/comfy         ComfyUI 연동 라이브러리(4-0): 서버 종류별 클라이언트, 그래프와 패치, 프로토콜, 모델 계열. dsh에 의존하지 않는다. 플러그인이 아니라 번들의 행이 없다
  comfy-provider/    카탈로그에 등록하는 생성 프로바이더, 실행기
  <이름>/            기능 컴포넌트 하나에 패키지 하나
  ui-kit/            자체 부품과 화면 공용 브라우저 코드
  ui-shell/          셸(브랜드, 내비게이터, 가운데 틀, 우측 탭)
  ui-<이름>/         화면 하나에 패키지 하나
scripts/             프로필 만들기, 실행, 합성 구성 찍기(`dsh.ts`, `dsh-env.ts`)
```

## 설계 과제

| 과제                                                                                  | 정하는 단계 |
| ------------------------------------------------------------------------------------- | ----------- |
| 에이전트 프리셋에 넣을 도구(셸·파일 도구를 줄지, 기본 제공 프리셋을 끌지)             | 1-4         |
| 접속·배포 구성                                                                        | 1-5         |
| UI 언어(한국어 언어 팩 여부, 문자열을 로케일 사전으로 옮길지)                         | 1-6         |
| 카탈로그 계약                                                                         | 2-1         |
| 기존 관계형 데이터(폴더, 태그, 검토 상태, 배치)를 기록과 리듀서로 옮기는 모양         | 2-3         |
| 프로젝트를 넘는 데이터의 자리                                                         | 2-3, 4-1    |
| 화면에 쓸 제품 이름과 마크, 숨길 기본 요소, 프로젝트 하나에 둘 세션 수                | 3-0         |
| 자체 부품의 범위와 디자인 문서                                                        | 3-1         |
| ComfyUI 서버 키를 dsh 자격 증명에 두는 법                                             | 4-1         |
