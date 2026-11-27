# DreamVerse Harness — 참조 구현

서버 쪽 네 계층과 화면 구성을 본뜨는 대상이다. 이 문서는 무엇을 어디서 가져오고 무엇을 바꾸는지를 적는다. 수치는 2026-11-25에 받은 사본(커밋 `ec0ac62760`)에서 셌다.

이 문서의 `packages/…`와 `docs/subsystems/…` 경로는 DreamVerse 저장소 안의 경로다. 이 저장소의 문서를 가리킬 때는 `docs/DSH.md`처럼 대문자 이름으로 적는다. 이 문서는 DreamVerse의 말을 따라 기능 컴포넌트를 "컴포넌트"라고 줄여 쓴다.

DreamVerse는 dsh 0.1.7-rc.1에서 갈라진 포크다. 여기 적힌 동작은 그 포크의 소스에서 읽은 것이고(`AGENTS.md` "확인 수준"의 소스 확인), 우리가 쓰는 dsh 0.2.2-rc.5에서 그대로 되는지는 "dsh 0.2.2-rc.5와의 차이"에 적은 만큼만 확인했다.

## 기본 정보

| 항목         | 값                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 저장소       | https://github.com/fastvideo-project/dreamverse-harness (기본 브랜치 `main`)                                                 |
| 본 커밋      | `ec0ac62760`(2026-11-19)                                                                                                     |
| 무엇인가     | dsh 안에서 도는 영상 제작용 프로젝트 계층이다. 캔버스, 타임라인, 에셋 풀, 샷 렌더, 캐릭터·장소·스타일을 다룬다.              |
| dsh와의 관계 | dsh를 **포크**했다. 분기점은 `46a7f68b09`(2026-09-23, dsh 0.1.7-rc.1)이고 그 뒤 업스트림을 병합하지 않았다.                  |
| 추가한 것    | `packages/dv/*`(패키지 디렉터리 53개, 그중 화면 `ui-*`가 22개), `packages/bundle/dv`(번들), `packages/video-harness`, `packages/mcp/mcp-servers`, `packages/mcp/mcp-bundle`, `packages/client/ui-mcp-servers`, `scripts/video-harness/setup-profile.sh`(`video-harness` 프로필) |
| 라이선스     | MIT. 저작권 표기는 "FastVideo Team, Hao AI Lab"과 "DeepSeek" 두 줄이다.                                                      |
| 설명 문서    | `docs/subsystems/video-harness.md`(계층, 기록, 히스토리 규칙, 용어), 각 패키지의 `README.md`, `packages/dv/project/CONTRACTS.md` |

## 계층

```
화면            @dv/ui-shell  @dv/ui-canvas  @dv/ui-timeline  @dv/ui-asset-pool  @dv/ui-composer  @dv/ui-history …
  │ HTTP /api/dv/… , /dv/events
  ▼
API             @dv/api                 상태를 읽고 연산을 사용자로서 실행하는 라우트, 이벤트 스트림
  │ dvProject.run, getState, listHistory
  ▼
프로젝트 계층   @dv/project             기록, 히스토리, 실행 취소, 상태, 에이전트 도구, 프롬프트의 프로젝트 절
  ▲ registerOperation, registerReducer
  │
작업 절차       @dv/workflow-story      컴포넌트의 도구를 부르는 순서(스킬)
  │
컴포넌트        @dv/asset-pool  @dv/character  @dv/location  @dv/style  @dv/shot-render  @dv/image-generate
                @dv/timeline  @dv/inspector  @dv/canvas  @dv/audio-generate  @dv/audio-edit
  │ defineGeneration, defineReference
  ▼
기반 라이브러리 @dv/generation  @dv/reference-kit
  │ ctx.dvModels
  ▼
카탈로그        @dv/models              모델 목록, 모델 고르기 도구
  ▲ 모델이 맡는 작업마다 항목 하나를 등록
  │
프로바이더      @dv/fastvideo  @dv/uniserve  @dv/sglang-diffusion  @dv/sglang-omni  @dv/vllm-omni  @dv/openrouter

번들            @dv/bundle              위 패키지들의 cordis.patch.yml 행, 에이전트 프리셋, 스킬
```

사용자가 말하는 "4계층"은 프로젝트 계층 / 카탈로그·프로바이더 / 컴포넌트 / 작업 절차다. DreamVerse는 넷째를 "workflows"라고 부른다. 이 저장소에서는 ComfyUI 워크플로와 헷갈리지 않게 "작업 절차"라고 부른다.

## 핵심 개념

**연산과 기록.** 프로젝트의 모든 변경은 연산 한 번의 호출이고, 프로젝트 폴더의 `.dreamverse/records.jsonl`에 기록 한 줄로 남는다. 이 파일은 `@dv/project`만 읽고 쓴다. 기록에는 누가(`actor`: user, agent, system), 어디서(`surface`: chat, canvas, timeline …), 왜(`intent`), 어느 컴포넌트의 어느 연산인지, 파라미터, 입력과 그것이 가리킨 에셋, 출력, 상태, 부모 기록이 들어간다. 기록은 추가만 한다. 상태 변화와 결과는 갱신 줄로 덧붙인다.

**연산 정의.** 컴포넌트는 `ctx.dvProject.registerOperation(spec)`으로 등록한다. `OperationSpec`의 필드(`packages/dv/project/src/operation-types.ts`):

```ts
name, component, version, description, label?      // description이 에이전트가 읽는 도구 설명이다
params, toolParams?                                // 파라미터 스키마
inputs, pendingInputRoles?, outputs                // 입력 에셋과 출력
deterministic, resource: 'none' | 'cpu' | 'gpu'
readOnly?, outsideHistory?, isConcurrencySafe?()
supersedes?(), basedOn?()                          // 어떤 기록을 대체하는지, 무엇을 바탕으로 했는지
summarize(record), omitParamsFromResult?
prepareToolCall?(call)                             // 에이전트 호출을 실행 전에 거절하거나 고친다
precondition?(request, state)                      // 누가 부르든 기록을 쓰기 전에 거절한다
execute(context)
```

도구 레지스트리(dsh의 `tools` 서비스)가 있으면 모든 연산이 에이전트 도구 `dv_<연산 이름>`이 된다. 화면은 같은 연산을 API로 부른다.

**실행 흐름.** 파라미터 검증 → 프로젝트 잠금 안에서 입력을 에셋으로 풀고 사전 조건 확인 → `pending` 기록 추가 → 잠금 밖에서 구현 실행 → 출력·비용·보고를 갱신 줄로 추가. 아직 끝나지 않은 기록을 입력으로 받은 호출은 스케줄러에서 기다린다.

**상태.** 리듀서가 기록을 읽어 상태를 계산한다. 리듀서는 기록을 쓰지 않는다. 컴포넌트마다 자기 리듀서가 `ProjectState.components`의 자기 조각을 만든다. 리듀서의 `agentSummary`가 에이전트에게 줄 요약을 덧붙인다. 화면은 상태를 들고 있지 않고, 이벤트가 올 때마다 다시 읽는다.

**히스토리 규칙.** 이미지 편집기의 히스토리 패널과 같다.

1. 프로젝트 내용의 변경은 단계다. 보기 상태(이동, 확대, 선택), 프로젝트 이름, 모델 선택은 단계가 아니다.
2. 실행 취소, 다시 실행, "이 단계로 돌아가기"는 현재 위치만 옮긴다. 단계를 더하지 않는다.
3. 현재 위치 뒤에 새 단계를 만들면 뒤의 단계들을 버린다. 끝나지 않은 버려진 단계는 취소된다.
4. 가져온 에셋은 남고, 생성된 에셋은 현재 위치를 따른다.

**카탈로그.** `@dv/models`의 `dvModels` 서비스다. 프로바이더 플러그인이 `ctx.dvModels.register(entry)`로 항목을 넣는다. 항목은 열쇠 `(modality, task, provider, model)`와 `description`, `facts()`, `schema()`, `validateGenerationRequest(request)`, `render(request, signal)`을 가진다. 기본 요청(`RenderRequest`)의 필드는 `prompt`, `references`(에셋 id 목록), `firstFrame`, `lastFrame`, 크기·길이(`frameWidth`, `frameHeight`, `numFrames`, `durationSec`, `aspectRatio`, `resolution`), `seed`, `extra`다. 요청 종류는 선언 병합으로 늘린다(`PrimitiveTypes`, `TaskMap`). 기본은 video이고 image와 audio는 `@dv/image-generate`와 `@dv/audio-generate`가 더했다. 프로바이더 하나는 200~900줄이고 가장 작은 예는 `@dv/sglang-diffusion`(207줄)이다.

**에이전트가 읽는 것.** 도구 하나의 쓰는 법은 연산의 `description`, 여러 컴포넌트에 걸친 절차는 스킬, 모델의 한계와 프롬프트 쓰는 법은 프로바이더가 등록하는 스킬, 매 턴 바뀌는 프로젝트 상태는 `@dv/project`가 대화에 덧붙이는 상태 메시지다.

**에이전트가 가진 도구.** 번들(`packages/bundle/dv/cordis.patch.yml`)이 에이전트 프리셋 `dreamverse`를 넣고 기본으로 둔다. 그 프리셋의 플러그인은 `persona`, `skill-filesystem`(자기 스킬 폴더만), `tool-skill`, `tool-ask-user`, compaction 묶음뿐이다. dsh 기본 프리셋에 있는 셸·파일 도구가 없다. 연산 도구는 프리셋이 아니라 `@dv/project`가 `tools` 서비스에 등록한다. 그래서 DreamVerse의 에이전트가 프로젝트를 바꾸는 길은 연산 도구뿐이다. 0.2.2-rc.5의 프리셋 구조와 우리 쪽 결정은 `docs/DSH.md` "에이전트 프리셋"에 있다.

**프로젝트와 폴더.** 프로젝트는 dsh 작업공간(폴더) 하나다. 새 프로젝트의 폴더는 "DreamVerse 폴더" 안에 만든다(화면이 `/api/dv/projects/untitled`로 경로를 받는다). 그 폴더의 위치는 dsh의 `defaultWorkspaceDirectory`(시스템의 문서 폴더를 기준으로 기본 작업공간 위치를 정한다)로 얻는다.

## 규모

소스 줄 수다(`src`의 `.ts`·`.tsx`, 테스트 제외).

| 부분                                                                | 줄 수                 |
| ------------------------------------------------------------------- | --------------------- |
| 프로젝트 계층 `@dv/project`                                         | 4,612                 |
| API `@dv/api`                                                       | 1,304                 |
| 카탈로그와 기반 라이브러리(`models`, `generation`, `reference-kit`) | 1,355                 |
| 프로바이더 여섯(`fastvideo` 898, `openrouter` 793, `uniserve` 396, `vllm-omni` 374, `sglang-omni` 216, `sglang-diffusion` 207) | 2,884 |
| 컴포넌트(11개 + `ffmpeg`, `chat-references`)                        | 5,494                 |
| 작업 절차 `@dv/workflow-story`                                      | 32 + 스킬 문서 244줄(번들의 `video-directing` 스킬 92줄은 따로다) |
| 그 밖(`fastvideo-generation-client` 640, `text-node` 535, `hardware` 468, `minimax-skills` 144, `mcp-presets` 41) | 1,828 |
| 화면 `@dv/ui-*`(22개)                                               | 21,178 + CSS 2,359줄  |

화면 쪽 주요 패키지: `ui-canvas` 4,134, `ui-timeline` 4,013, `ui-composer` 2,904, `ui-shell` 2,846, `ui-kit` 2,458, `ui-history` 923, `ui-asset-pool` 679.

## dsh 0.2.2-rc.5와의 차이

DreamVerse는 dsh 0.1.7-rc.1에서 갈라졌다. 서버 쪽 코드가 지금 쓰는 0.2.2-rc.5에 맞는지 타입 검사로 확인했다(2026-11-25).

- **방법**: 14개 패키지(`project`, `api`, `models`, `generation`, `reference-kit`, `asset-pool`, `canvas`, `character`, `image-generate`, `inspector`, `chat-references`, `ffmpeg`, `shot-render`, `timeline`)의 소스 12,193줄을 복사하고, 설치된 dsh 0.2.2-rc.5 패키지의 타입에 대해 `tsc --noEmit`(TypeScript 5.9.3, DreamVerse의 엄격한 옵션 그대로)을 돌렸다.
- **결과**: dsh와 어긋나는 곳은 5건이고 모두 `@dv/project`다. 원인은 둘이다.

| 위치                                          | 내용                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project/src/index.ts:45`                     | `defaultWorkspaceDirectory`를 `@deepseek-ai/dsh-api-workspace-controller`의 루트에서 가져온다. 이 루트 export는 DreamVerse가 포크에서 더한 한 줄이라 0.2.2-rc.5에는 없다. 함수는 그 패키지의 `src/default-directory.ts`에 있지만 공개 진입점으로 나오지 않는다(`./default-workspace` 하위 경로는 상수 `DEFAULT_WORKSPACE_DIRECTORY`와 `workspaceDisplayTitle`만 내보낸다). 인자도 다르다(포크는 `('DreamVerse', undefined, signal)`로 부르고 0.2.2-rc.5의 함수는 `(documentsDirectory, signal)`을 받는다). 새 프로젝트 폴더의 위치를 어떻게 얻을지 2-0에서 정한다. |
| `project/src/project-updates.ts:149`          | `ProjectionDefinition`이 타입 인자를 둘 받는다(`<K, S>`).                                                                                                                                                                             |
| `project/src/project-updates.ts:280`, `:287`  | `:280`의 `ctx.sessionProjections.register()`와 `:285`의 `stateOf()`의 모양이 바뀌었다. `:287`은 `stateOf()`가 돌려준 값을 쓰는 곳이다.                                                                                               |
| `project/src/agent-tools.ts:163`              | `ctx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn`이 타입에 없다.                                                                                                                                                    |

세션 프로젝션의 변화: 분기점에서는 열쇠별 상태 타입 표(`SessionProjectionStateMap`)와 `stateOf(session, key)`가 있었다. 0.2.2-rc.5에서는 서비스의 `stateOf(session, key)`가 deprecated이고 `unknown`을 돌려준다. 등록이 돌려주는 핸들의 `handle.stateOf(session)`을 쓰라고 되어 있다. 문서는 업스트림 `docs/subsystems/session-projection.md`다.

- **한계**: 위 타입 검사는 타입이 맞는다는 것뿐이다. `@dv/project`는 2-0에서 `@cs/project`로 옮겨 실행했다(2026-11-27, 아래 "2-0에서 실행해 본 결과"). 나머지 13개 패키지는 **실행해 보지 않았다.** 이벤트의 의미나 실행 순서가 달라졌을 수 있다.
- 시험 구성 탓에 난 오류 2건(`mime-types` 타입 없음, 패키지를 한 프로그램으로 묶어서 생긴 캐스트 오류)은 세지 않았다.

**2-0에서 실행해 본 결과**(2026-11-27, `@dv/project` → `@cs/project`):

- 위 5건을 고친 뒤 옮긴 단위 시험 113개가 전부 통과했다. 시험 가운데 넷(`agent-tools`, `proj-tools`, `project-updates`, 시험용 플러그인)은 실제 Cordis `Context`에 dsh 0.2.2-rc.5의 `tools`·`systemPrompt` 플러그인을 올려 돈다.
- 소스의 타입 검사에는 걸리지 않았지만 **시험 코드에서 더 나온 차이가 하나 있다**: 도구 실행 API다. 분기점에서는 `tools.execute({ callId, name, arguments, signal, agent })`로 호출 하나를 실행했다. 0.2.2-rc.5에서는 묶음(`calls: ToolCallBlock[]`)을 받고, 실행기를 따로 올려야 한다(`@deepseek-ai/dsh-tool-executor-native`). 프로젝트 계층의 소스는 도구를 정의만 하고 직접 실행하지 않으므로 소스는 고칠 것이 없었다.
- 실제 dsh 안에서도 돈다(조합 시험): 서비스가 번들의 행으로 올라오고, 작업공간 등록부에 프로젝트가 생기고, 기록·상태·실행 취소·다시 실행이 되고, 연산 도구가 레지스트리에 등록된다.
- 고친 내용과 dsh 쪽 사실은 `docs/DSH.md` "호스트 쪽"과 `docs/archive/PLAN_2-0.md`에 있다.
- 화면 쪽은 import한 이름만 대조했다. 세 패키지가 0.2.2-rc.5에 없는 이름을 쓴다: `@dv/ui-composer`(`PromptChip`, `PromptContent`, `PromptChangeCause`, `PromptHostModel`, `ReferenceFaceOwner`, `MarkdownElement`, `MarkdownTableElement` 일곱 개), `@dv/ui-text-node`(`PromptContent`, `PromptHostModel` 등), `@dv/ui-mcp-presets`(포크가 더한 `@deepseek-ai/dsh-mcp-servers`). 포크 전용 확장점에 기대는 패키지다.

## 가져올 것, 바꿀 것, 가져오지 않을 것

| 대상                                                   | 판단             | 이유                                                                                                                     |
| ------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@dv/project`(기록, 실행기, 히스토리, 상태, 도구화)    | **가져왔다**(2-0) | 도메인과 무관한 틀이다. `packages/project`(`@cs/project`)가 됐다. 이름은 `.comfy-studio`, `cs_`, `csProject`로 바꿨고 영상 용어는 글과 `surface` 값에서 걷어냈다(`docs/DECISIONS.md` "확정"). |
| `@dv/api`                                              | 가져온다         | 화면용 API의 모양이다. 영상 전용 라우트는 뺀다.                                                                          |
| `@dv/models`(카탈로그 틀)                              | 틀만 가져온다    | 등록·조회·선언 병합 구조는 쓴다. 요청과 항목의 모양은 ComfyUI에 맞게 새로 정한다(`docs/ARCHITECTURE.md` "카탈로그 계약"). |
| `@dv/generation`, `@dv/image-generate`                 | 참고             | 생성 컴포넌트를 만드는 틀이다. 프롬프트 기반이라 그래프 기반에 맞게 다시 쓴다.                                           |
| `@dv/asset-pool`                                       | 가져와 고친다    | 에셋을 프로젝트 폴더에 내용 기준으로 저장하고 내려준다. 폴더·태그·검토 상태는 우리가 더한다.                             |
| `@dv/character`, `@dv/reference-kit`                   | 참고             | 버전을 가진 참조 대상의 틀이다. 기존 앱의 캐릭터와 모양이 다르다.                                                        |
| `@dv/chat-references`                                  | 참고             | 채팅에서 가리킨 것을 프로젝트 id로 바꾼다. 포크 전용 확장점에 기대는 부분은 뺀다.                                        |
| `@dv/inspector`, `@dv/ffmpeg`                          | 필요할 때        | 미디어 검수를 옮기기로 하면 본다.                                                                                        |
| `@dv/canvas`와 `@dv/ui-canvas`                         | 미정             | 가운데에 캔버스를 둘지에 달렸다. 기존 앱에는 캔버스가 없다.                                                              |
| 프로바이더 여섯                                        | 가져오지 않는다  | 영상·이미지 모델 서버용이다. 프로바이더 하나의 모양만 본다.                                                              |
| `@dv/shot-render`, `@dv/timeline`, `@dv/audio-*`, `@dv/location`, `@dv/style`, `@dv/workflow-story` | 가져오지 않는다 | 영상 제작 전용이다.                                                              |
| `@dv/text-node`, `@dv/hardware`, `@dv/minimax-skills`, `@dv/mcp-presets`, `@dv/fastvideo-generation-client`와 그 화면 패키지 | 읽지 않았다 | 줄 수만 셌다. 필요해 보이면 그때 읽는다.                         |
| `@dv/bundle`의 에이전트 프리셋                         | 방식을 가져온다  | 자기 프리셋을 기본으로 두는 방식이다. 프리셋에 무엇을 넣을지는 미정이다(1-4).                                            |
| `@dv/ui-shell`                                         | 방식을 가져온다  | 슬롯 교체, 우측 탭, 기본 요소 숨김. 확인 결과는 `docs/DSH.md` "화면 교체"에 있다.                                        |
| `@dv/ui-kit`, `@dv/ui-history`, `@dv/ui-asset-pool`    | 참고             | API 클라이언트, 상태를 다시 읽는 훅, 기록 패널, 에셋 패널.                                                               |
| `@dv/ui-composer`, `@dv/ui-text-node`, `@dv/ui-mcp-presets` | 가져오지 않는다 | 포크 전용 확장점이 있어야 돈다.                                                                                      |

가져온 코드는 영상 용어(shot, take, timeline)를 걷어내야 한다. 어디까지 걷어낼지는 단계마다 정한다.

## DreamVerse가 dsh 코어에 넣은 패치

분기점(`46a7f68b09`)과 비교한 `git diff --shortstat` 결과다(2026-11-25).

| 범위                                                                                                                                                                                              | 파일 | 줄                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------- |
| `packages/dv`와 `docs`를 뺀 전부                                                                                                                                                                  | 265  | +17,591, −463     |
| 위에서 포크가 새로 만든 패키지(`packages/bundle/dv`, `packages/video-harness`, `packages/mcp/mcp-servers`, `packages/mcp/mcp-bundle`, `packages/client/ui-mcp-servers`)와 `*.md`, `pnpm-lock.yaml`, `scripts`, `snapshots`, 테스트를 더 뺀 것 | 72 | +1,947, −208 |
| 그중 기존 UI 패키지의 소스(`packages/client/*/src`, 테스트 제외)                                                                                                                                  | 40   | +1,091, −141      |

기존 UI 소스의 패치는 `ui-conversation` +599, `ui-input-trigger` +244, `ui-primitives` +165, `ui-chat` +55, `ui-sidebar-right` +15, `ui-slots` +5, `ui-renderer` +5다. 이 패치로 생긴 확장점이 `docs/DSH.md` "포크에서만 되는 것"이다. 우리는 포크하지 않으므로 쓸 수 없다.

## 라이선스와 이름

- 코드를 가져오면 MIT 고지를 남긴다. 가져온 파일의 출처(저장소와 커밋)를 적고, 고지는 이 저장소 루트의 `THIRD_PARTY_NOTICES.md`에 모은다(DreamVerse와 dsh도 이 파일 이름을 쓴다).
- DreamVerse의 이름과 로고를 쓰지 않는다.
- dsh의 브랜드 지침(`BRAND_GUIDELINES.md`): 설명에는 "built on DeepSeek Harness"라고 쓸 수 있다. 프로젝트 이름에는 "DeepSeek Harness" 전체 대신 "DSH"를 쓴다. 공식 브랜드 자료를 제휴로 오해받게 쓰지 않는다. 이 저장소 이름 `dsh-comfy-studio`는 그 형태다.

## 먼저 읽을 파일

| 파일                                                                 | 왜                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| `docs/subsystems/video-harness.md`                                   | 계층, 기록, 히스토리 규칙, "새 동작은 어디에", 용어집 |
| `packages/dv/project/README.md`, `CONTRACTS.md`                      | 프로젝트 계층의 서비스와 내부 모듈                    |
| `packages/dv/project/src/operation-types.ts`, `types.ts`             | 연산과 기록의 타입                                    |
| `packages/dv/models/README.md`, `src/types.ts`                       | 카탈로그의 열쇠, 항목, 요청                           |
| `packages/dv/sglang-diffusion/src/index.ts`                          | 가장 작은 프로바이더                                  |
| `packages/dv/asset-pool/src/index.ts`                                | 컴포넌트 하나가 연산·라우트·캔버스 노드를 등록하는 법 |
| `packages/dv/api/README.md`                                          | 화면용 API                                            |
| `packages/dv/ui-shell/src/client/index.ts`, `tabs.tsx`, `chrome.tsx` | 셸의 슬롯 교체, 우측 탭, 기본 요소 숨김               |
| `packages/bundle/dv/cordis.patch.yml`                                | 번들의 패치 행 구성, 에이전트 프리셋                  |
