# 기존 comfy-studio — 대체 대상

이 저장소가 대체하려는 앱이다. 도메인 요구사항과 옮겨 올 코드가 여기에 있다. 수치는 2026-11-25에 확인했다.

**기존 저장소는 읽기만 한다.** 지금 쓰이고 있는 앱이다. 코드도 `data/`도 고치지 않는다.

**기존 저장소는 비공개이고 이 저장소는 공개다.** 그래서 이 문서에는 기존 앱의 운영 데이터(DB 행 수, 용량, 사용 통계, 운영 기록에서 끌어낸 판단)와 사용자의 서버·배포 환경(기존 앱이 어떻게 배포돼 있는지 포함)을 적지 않는다(`AGENTS.md` "꼭 지킬 것"). 필요하면 로컬에서 확인한다.

이 문서의 `src/…`, `data/…` 경로는 기존 저장소 안의 경로다. 기존 저장소의 문서는 이 저장소의 같은 이름 문서와 헷갈리지 않게 `comfy-studio/docs/…`로 적는다. 기존 저장소의 문서는 에이전트(채팅에서 도구를 부르는 LLM)를 "모델"이라고 부른다. 이 문서에서는 "에이전트"로 옮겨 적었다.

## 기본 정보

| 항목        | 값                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 위치        | 이 장비의 `~/repo/comfy-studio`. 마지막 커밋은 2026-11-22 `92320c7`(Phase 19 병합)이다.                                                        |
| 무엇인가    | 1인 사용자용 AI 보조 에셋 제작 스튜디오. Next.js 하나가 UI, API, LLM 연동, ComfyUI 연동을 모두 맡는다.                                         |
| 스택        | Next.js 16 App Router, React 19, TypeScript strict, Tailwind v4 + 자체 부품, SQLite(better-sqlite3) + Drizzle, iron-session, zod v4, Vitest    |
| LLM         | `@anthropic-ai/sdk`와 `openai` SDK를 직접 쓴다. 프로바이더에는 API 키 방식(`anthropic`, `openai`, `openai_compatible`)과 OAuth 로그인 방식이 있다. |
| 규모        | `src` 63,172줄 + 테스트 25,089줄. 화면(`src/components`)의 `.tsx`가 약 21,600줄이고(`.ts`까지 약 23,200줄) 그중 자체 부품(`src/components/ui`)이 942줄이다. |
| 읽을 문서   | `comfy-studio/AGENTS.md`(규칙), `comfy-studio/docs/ARCHITECTURE.md`(동작의 상세. "ComfyUI 연동" 절이 가장 자세하다), `comfy-studio/docs/CONVENTIONS.md`, `comfy-studio/docs/ROADMAP.md`(기능 이력), `comfy-studio/docs/DESIGN.md`(토큰과 부품), `comfy-studio/docs/PHASE17_PLAN.md`~`PHASE19_PLAN.md` |

## 기능

기존 로드맵의 Phase 순서다.

| Phase | 기능                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------- |
| 1     | AI 채팅, LLM 프로바이더 관리, 로그인, 메시지 재생성·편집, 첨부 이미지                                   |
| 2     | ComfyUI 연동: 서버 등록, 워크플로 업로드와 실행 폼, 진행률, 결과 수집, 갤러리, 취소, 입력 이미지        |
| 3     | AI × Comfy 보조: 에이전트가 도구로 워크플로를 보고 생성을 제안·실행                                     |
| 4     | 프로젝트와 에셋 관리: 태그, 검색, 비교                                                                  |
| 6     | RunPod Serverless 연동                                                                                  |
| 7     | 에이전트가 편집하는 워크플로(그래프 패치)                                                               |
| 8, 15 | 프리셋, 프리셋 노트화                                                                                   |
| 9     | 웹 검색                                                                                                 |
| 10    | 채팅에서 워크플로 입력 미디어(이미지·오디오·영상)                                                       |
| 11    | 프로젝트 작업 공간: 배치와 검토, 폴더, 프로젝트 문서                                                    |
| 12    | 캐릭터: 프로필, 레퍼런스, 프로젝트 연결                                                                 |
| 13    | 역할 에이전트와 위임                                                                                    |
| 14    | Blender 렌더                                                                                            |
| 16    | 스킬 가져오기(GitHub 스킬 폴더 → 프리셋)                                                                |
| 17    | 워크플로는 서버에서 가져온다: 실행 기록에서 가져오기, PNG에서 가져오기, 서버 간 준비 점검               |
| 18    | 모델 인식 생성: 모델 계열 레지스트리, 서버 모델 메타데이터, 계열 경고, 가져온 이미지의 생성 정보        |
| 19    | 자율 실행: 연결에서 뗀 턴, 진행·안 읽음, 예약 실행, 프리셋 자동 개선·돌아보기, 기억과 대화 검색         |

그 밖에 Modal 게이트웨이 연동, MCP 서버, 사용량·요금 집계, S3 호환 스토리지, 백업·내보내기가 있다.

## 코드 구성

`src/lib`의 디렉터리별 줄 수다(테스트 제외). 이 밖에 `src/lib/*.service.ts`(DB 접근)와 `src/app`(라우트), `src/components`(화면)가 있다. "새 구조에서" 열의 낱말은 아래 "대응표"의 상태와 같은 뜻이다.

| 디렉터리     | 줄 수 | 내용                                              | 새 구조에서                                        |
| ------------ | ----- | ------------------------------------------------- | -------------------------------------------------- |
| `comfy`      | 5,786 | ComfyUI 연동                                      | 계획 4가 옮긴다(아래)                              |
| `tools`      | 5,519 | 에이전트 도구 정의                                | 기능 컴포넌트의 연산이 된다(계획 2)                |
| `llm`        | 2,489 | 프로바이더 추상화, OAuth                          | dsh                                                |
| `media`      | 1,604 | ffmpeg, 받아쓰기, Blender, PNG 텍스트, 생성 정보  | 미정(`png-text.ts`는 4-0에서 같이 옮긴다)          |
| `db`         | 1,063 | 스키마와 마이그레이션                             | 기록과 리듀서로 바뀐다                             |
| `presets`    | 923   | 프리셋 순수 로직, 스킬 가져오기                   | 후보: dsh 스킬(`match.ts`는 4-0에서 같이 옮긴다)   |
| `chat`       | 897   | 턴 서비스, 턴 허브, SSE                           | dsh                                                |
| `search`     | 772   | 웹 검색                                           | 후보: dsh 웹 검색                                  |
| `storage`    | 562   | 로컬·S3 스토리지, SigV4                           | 미정(`sigv4.ts`·`keys.ts`는 4-0에서 같이 옮긴다)   |
| `characters` | 377   | 캐릭터 순수 로직                                  | 기능 컴포넌트(계획 2)                              |
| `mcp`        | 312   | MCP 클라이언트                                    | dsh                                                |
| `agents`     | 226   | 역할 에이전트                                     | 후보: dsh 에이전트 프리셋과 서브에이전트           |
| `auth`       | 156   | 비밀번호 로그인, 세션                             | dsh의 방식으로 바뀐다(미정, 1-5)                   |
| `schedules`  | 137   | 예약 주기 계산                                    | dsh                                                |

## ComfyUI 연동

상세 명세는 기존 저장소의 `comfy-studio/docs/ARCHITECTURE.md` "ComfyUI 연동" 절이다. 옮기기 전에 반드시 읽는다. 여기에는 뼈대만 적는다.

```
요청 ─▶ runner.startGeneration ─▶ ComfyBackend.queuePrompt
                                    local·cloud: ComfyUI POST /prompt (+ WebSocket /ws 진행률)
                                    runpod:      RunPod POST /run
                                    modal:       게이트웨이 POST /run
진행 ◀── ComfyBackend.result 폴링(완료 판정. runpod·modal은 진행률도 여기서)
결과 ◀── ComfyBackend.view ─▶ 스토리지 + 에셋
```

- **서버 종류 넷**: `local`(ComfyUI), `cloud`(Comfy Cloud, `/api` 접두사 + `X-API-Key`), `runpod`(RunPod 작업 API + 네트워크 볼륨의 S3 호환 API), `modal`(GPU 없는 HTTP 게이트웨이를 거친다).
- **`ComfyBackend` 인터페이스**(`backend.ts`)가 넷을 가린다: `systemStats`, `objectInfo`, `listNodeClasses`, `queuePrompt`, `result`, `cancel`, `uploadImage`, `view`, 그리고 선택 메서드 `openSocket`, `releaseOutputs`, `listHistory`, `listModels`, `modelMetadata`.
- **워크플로**는 API 형식 그래프(`{ 노드 id: { class_type, inputs } }`)만 받는다. 리터럴 입력만 폼 필드가 된다.
- **그래프 패치**(`graph-patch.ts`): 연산은 `set`, `link`, `add`, `remove`다. `applyGraphPatch`가 복사본에 적용하고 `validateGraph`가 검사한다. `newProblems(template, patched)`로 패치가 새로 만든 문제만 본다.
- **완료 판정은 폴링**이다. WebSocket은 진행률과 "곧 끝남" 신호만 준다. WebSocket이 막힌 환경에서도 돈다.
- **취소**의 결과는 셋이다: `canceled`, `running`, `finished`.
- **준비 점검**(`readiness.ts`): 워크플로가 어느 서버에서 도는지 노드 카탈로그와 대조해 빠진 노드, 없는 모델 파일, 확인 불가를 낸다.
- **모델 계열**(`model-families.ts`): 13개 계열의 그리드, 기본값, CFG 범위, 네거티브 유무, 프롬프트 문체. 판정은 사용자 지정 → safetensors 메타데이터 → 파일 이름 순이다.
- 실행 추적 상태는 서버 프로세스 메모리에 있고, 재시작 뒤 진행 중이던 실행은 폴링을 다시 시작한다.

### 옮길 수 있는 범위

`src/lib/comfy`는 23개 파일 5,786줄이고 테스트 파일 21개(5,299줄)가 옆에 있다. 파일마다 `lib/comfy` 밖에서 무엇을 **값으로** 가져오는지를 import 문에서 셌다(2026-11-25. `@/` 별칭과 상대 경로 모두, 다른 파일을 거쳐 닿는 것 포함).

- **`runner.ts`와 `input-image.ts`를 뺀 21개 파일(5,108줄)은 보조 모듈 넷(263줄)만 같이 옮기면 앱 없이 선다.** 4-0이 옮기는 범위다.
- `runner.ts`(657줄)는 앱 서비스 열한 개에 묶여 있어 옮기지 않고 4-2에서 프로젝트 계층에 맞춰 새로 쓴다. `input-image.ts`(21줄)는 4-2에서 다룬다.

| 파일                                                                 | 줄 수 | `lib/comfy` 밖에서 값으로 가져오는 것                                              | 옮기는 단계 |
| -------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------- | ----------- |
| `client.ts` — ComfyUI HTTP 구현(local, cloud)                        | 583   | 없음(타입: `db/schema`)                                                            | 4-0         |
| `protocol.ts` — 응답 파서                                            | 466   | 없음(타입: `db/schema`)                                                            | 4-0         |
| `workflow.ts` — 그래프와 필드의 순수 로직                            | 408   | 없음                                                                               | 4-0         |
| `graph-patch.ts` — 패치 연산과 검증                                  | 371   | 없음                                                                               | 4-0         |
| `modal/client.ts`                                                    | 346   | 없음                                                                               | 4-0         |
| `node-catalog.ts` — 노드 카탈로그 캐시와 검색                        | 214   | 없음                                                                               | 4-0         |
| `runpod/protocol.ts`, `runpod/object-info.ts`                        | 266   | 없음(타입: `attachments/media`)                                                    | 4-0         |
| `family-checks.ts`, `model-loaders.ts`                               | 295   | 없음                                                                               | 4-0         |
| `backend.ts`, `readiness.ts`                                         | 205   | 없음(타입: `db/schema`)                                                            | 4-0         |
| `graph-diff.ts`, `graph-text.ts`, `handoff.ts`                       | 183   | 없음                                                                               | 4-0         |
| `events.ts`                                                          | 28    | 없음(타입: `db/schema`, `generations.service`)                                     | 4-0         |
| `embedded-graph.ts`                                                  | 43    | `media/png-text`(110줄, 의존 없음)                                                 | 4-0         |
| `model-families.ts`                                                  | 912   | `presets/match`(48줄, 의존 없음. 파일 이름 패턴 매칭)                              | 4-0         |
| `family-text.ts`                                                     | 153   | `model-families.ts`를 거쳐 `presets/match`(타입: `model-meta/types`)               | 4-0         |
| `runpod/volume.ts`                                                   | 268   | `storage/sigv4`(96줄), `storage/keys`(9줄). 둘 다 Node 내장 모듈만 쓴다            | 4-0         |
| `runpod/client.ts`                                                   | 367   | `runpod/volume.ts`를 거쳐 위 둘                                                    | 4-0         |
| `input-image.ts`                                                     | 21    | `attachments/image`(60줄), `sharp`                                                 | 4-2         |
| **`runner.ts`**                                                      | 657   | **깊게 묶여 있다**: 에셋, 배치, 캐릭터, 입력, 서버, 대화, 생성, 프로젝트, 워크플로 서비스와 인증 가드, 썸네일 | 새로 쓴다(4-2) |

옮길 때 볼 것:

- **같이 옮길 보조 모듈 넷**: `media/png-text.ts`, `presets/match.ts`, `storage/sigv4.ts`, `storage/keys.ts`. 앞의 셋에는 테스트가 있다(`png-text.test.ts`, `match.test.ts`, `sigv4.test.ts`).
- **테스트**: 21개 가운데 18개가 4-0의 파일에 붙어 있다. `input-image.test.ts`, `runner.test.ts`, `runner.runpod.test.ts`는 4-2에서 다룬다.
- **타입만 가져오는 곳**은 옮긴 패키지 안의 타입으로 바꾼다: `db/schema`(서버 종류 등), `generations.service`, `model-meta/types`, `attachments/media`.
- **걷어낼 것**: `@/` 경로 별칭(11개 파일)과 `import "server-only"`(6개 파일: `client.ts`, `runner.ts`, `input-image.ts`, `runpod/volume.ts`, `runpod/client.ts`, `modal/client.ts`). Next.js(`next/*`)를 가져오는 곳은 없다.
- **서드파티 의존**: `zod`(7개 파일), `nanoid`(`modal/client.ts`, `runpod/client.ts`, `runner.ts`), `sharp`(`input-image.ts`).
- 오류 메시지는 한국어다(`ComfyError`).
- 키를 다른 출처로 보내지 않는 처리(`/view` 리다이렉트를 수동으로 따라간다)를 그대로 지킨다.

## 에이전트 도구

`src/lib/tools`에 정의된 도구 48개다. 새 구조에서는 기능 컴포넌트의 연산이 되고, 연산이 곧 도구다. 주제별로 묶었다(도구 그룹은 `workflow`, `generate`, `vision`, `project`, `review`, `web`, `mcp`, `delegate`이고 배정은 기존 `lib/tools/registry.ts`가 기준이다).

| 주제          | 도구                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 워크플로      | `list_workflows`, `get_workflow`, `get_workflow_graph`, `save_workflow`, `propose_graph_patch`, `search_node_classes`, `describe_node_class`, `check_workflow_requirements`                          |
| 서버          | `list_comfy_servers`, `list_server_runs`, `import_server_run`                                                                                                                                        |
| 생성          | `propose_generation`, `start_generation`, `get_generation`, `list_generations`, `wait_for_runs`                                                                                                      |
| 보기·검수     | `view_image`, `view_media`, `inspect_media`, `transcribe_audio`, `submit_review`                                                                                                                     |
| 에셋          | `list_assets`, `list_asset_folders`, `create_asset_folder`, `update_asset_folder`, `move_assets`, `tag_assets`                                                                                       |
| 프로젝트 문서 | `list_projects`, `list_project_files`, `read_project_file`, `create_project_document`, `update_project_document`, `add_project_link`                                                                 |
| 캐릭터        | `list_characters`, `get_character`, `create_character`, `update_character_profile`, `add_character_reference`                                                                                        |
| 프리셋        | `read_preset`, `propose_preset_create`, `propose_preset_update`                                                                                                                                      |
| 삭제          | `propose_delete`                                                                                                                                                                                     |
| Blender       | `render_blender`, `get_blender_render`                                                                                                                                                               |
| 그 밖         | `web_search`, `fetch_page`, `search_conversations`, `delegate`                                                                                                                                       |

## 데이터

SQLite 테이블은 28개다.

```
settings providers projects conversations messages turn_runs usage_events attachments
comfy_servers comfy_server_models mcp_servers workflows generation_batches generations
asset_folders assets characters character_reference_roles character_references project_characters
project_files project_file_versions tags asset_tags presets preset_versions agents schedules
```

주요 값: 서버 종류 `local`·`cloud`·`runpod`·`modal`, 생성 상태 `queued`·`running`·`succeeded`·`failed`·`canceled`, 배치 상태 `pending`·`reviewed`, 에셋 종류 `image`·`video`·`audio`·`file`, 에셋 출처 `generation`·`upload`·`render`, 검토 상태 `pending`·`adopted`·`held`.

쌓인 양(DB와 저장 파일의 크기, 테이블별 행 수)은 운영 데이터라 이 문서에 적지 않는다. 옮기기로 하면 그때 로컬에서 읽기 전용으로 센다. `data/` 폴더에는 사용자 데이터가 아닌 것(설치된 도구)도 들어 있으므로 폴더 전체 크기로 어림하지 않는다.

옮길지와 범위는 정해지지 않았다(`docs/DECISIONS.md` "미정").

## 대응표

기존 기능이 새 구조에서 어디로 가는지다. "상태" 열의 낱말:

- **dsh** — dsh의 기본 기능이 맡는다. 사용자가 정한 방향("dsh로 변경 할수 있는건 dsh로 변경")에 따른 것이다. 패키지와 문서로만 확인했고, 실제 동작은 1-3과 1-4에서 써 본다.
- **후보** — dsh에 해당 패키지나 문서가 있다는 것만 확인한 추정이다. 기존 기능을 그것으로 대신할 수 있는지는 1-4에서 써 보고 사용자와 정한다.
- **옮긴다**, **다시 설계한다** — 우리가 만든다.
- **미정** — 옮길지부터 정해지지 않았다.

| 기존 기능                                   | 기존 구현                                   | 새 자리                                                       | 상태                                              |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| LLM 프로바이더 관리                         | `lib/llm`, `providers`                      | dsh 설정 → Models                                             | dsh. OAuth 로그인 방식의 프로바이더가 되는지는 미확인 |
| 스트리밍 채팅, 대화 저장, 재생성·편집       | `lib/chat`, `conversations`, `messages`     | dsh 세션과 대화 화면                                          | dsh. 재생성·편집의 동작은 미확인                  |
| 도구 호출 루프                              | 프로바이더 구현 안                          | dsh 도구 루프                                                 | dsh                                               |
| 연결에서 뗀 턴, 진행·안 읽음                | `turn-hub`, `turn_runs`                     | dsh 호스트의 에이전트 루프                                    | dsh. 브라우저를 닫아도 턴이 도는지는 미확인(1-3)  |
| MCP 서버                                    | `lib/mcp`, `mcp_servers`                    | dsh MCP(`mcp-manager`)                                        | dsh                                               |
| 예약 실행                                   | `schedules`, `lib/scheduler.ts`             | dsh 예약(`schedule`, Automation tasks 화면)                   | dsh. 예약 도구는 에이전트 프리셋에 넣어야 한다    |
| 웹 검색, 페이지 가져오기                    | `web_search`, `fetch_page`                  | dsh 웹 검색(`web-search-deepseek`), 웹 도구(`tool-web`)       | 후보. DeepSeek 외 모델에서 되는지 미확인          |
| 프리셋, 스킬 가져오기, 자동 개선            | `presets`, `preset_versions`                | dsh 스킬                                                      | 후보                                              |
| 역할 에이전트, 위임                         | `agents`, `delegate`                        | dsh 에이전트 프리셋, 서브에이전트                             | 후보                                              |
| 기억, 대화 검색                             | 프리셋 + `messages_fts`                     | dsh 스킬, 세션 검색, 서드파티 MCP 기억                        | 후보                                              |
| 첨부(이미지·오디오·영상)                    | `attachments`                               | dsh 첨부                                                      | 후보. 오디오·영상은 미확인                        |
| 프로젝트 문서와 버전                        | `project_files`, `project_file_versions`    | 작업공간 폴더의 파일(dsh 파일 도구)                           | 후보. 에이전트에게 파일 도구를 줄지에 달렸다(1-4) |
| 로그인                                      | 비밀번호 + iron-session                     | dsh의 토큰 주소 + 세션 쿠키                                   | 방식이 다르다. 미정(1-5)                          |
| 비밀값 저장                                 | AES-256-GCM, `APP_SECRET`                   | dsh 자격 증명 저장소                                          | dsh. 플러그인에서 쓰는 법은 미확인(4-1)           |
| ComfyUI 서버 등록과 연동                    | `lib/comfy`, `comfy_servers`                | 계획 4                                                        | 옮긴다                                            |
| 워크플로: 템플릿, 가져오기, 그래프 패치     | `workflows`, `graph-patch.ts`               | 계획 2의 기능 컴포넌트 + 계획 4의 라이브러리                  | 옮긴다                                            |
| 모델 계열, 준비 점검, 노드 카탈로그         | `model-families.ts`, `readiness.ts`         | 계획 4                                                        | 옮긴다                                            |
| 생성, 배치, 검토                            | `generations`, `generation_batches`, `runner.ts` | 계획 2의 기능 컴포넌트(기록) + 계획 4(실행)              | 다시 설계한다                                     |
| 에셋, 갤러리, 폴더, 태그, 비교              | `assets`, `asset_folders`, `tags`           | 계획 2의 기능 컴포넌트 + 계획 3의 화면                        | 다시 설계한다                                     |
| 프로젝트, 작업 공간                         | `projects`, `(workspace)` 라우트            | dsh 작업공간(폴더) 하나가 프로젝트 하나 + 프로젝트 계층       | 다시 설계한다                                     |
| 캐릭터                                      | `characters` 외 3개 테이블                  | 계획 2의 기능 컴포넌트                                        | 다시 설계한다. 전역 라이브러리의 자리는 미정      |
| 미디어 검수(ffmpeg, 받아쓰기), Blender 렌더 | `lib/media`                                 | 기능 컴포넌트                                                 | 미정                                              |
| 사용량·요금                                 | `usage_events`                              | —                                                             | 미정                                              |
| S3 호환 스토리지, 백업                      | `lib/storage`, `lib/zip.ts`                 | —                                                             | 미정                                              |

## 유지할 도메인 규칙

기존 저장소가 정한 규칙 가운데 구현이 아니라 동작에 관한 것이다. 출처는 `comfy-studio/AGENTS.md` "꼭 지킬 것", `comfy-studio/docs/ARCHITECTURE.md` "ComfyUI 연동", `comfy-studio/docs/CONVENTIONS.md`다. 옮길 때 그대로 지킨다. 구조가 달라져도 뜻은 같아야 한다.

- **에이전트는 아무것도 직접 지우지 않는다.** 삭제는 제안이고, 사용자가 채팅의 카드에서 승인할 때 실행된다.
- **에이전트는 캐릭터 프로필과 프리셋을 직접 쓰지 않는다.** 제안 카드를 내고 사용자가 승인하면 적용한다. 예외는 사용자가 "자동 개선"을 켠 프리셋에 부분 수정만 담은 제안 하나다(한 요청에 프리셋당 3회까지). 이 예외를 넓히지 않는다.
- **에이전트가 바꾼 문서와 프리셋은 이전 내용이 버전으로 남는다.**
- **워크플로는 템플릿이다.** 그래프를 바꿀 때는 그래프 패치 연산으로만 바꾸고, 서버로 보내기 전에 검증한다. 템플릿 그래프를 덮어쓰지 않는다. 남기고 싶으면 변형을 새로 만든다.
- **계열에 어긋나는 값은 경고만 한다.** 실행 직전에 값을 몰래 바꾸지 않는다.
- **모델 계열 규칙은 한 곳에만 둔다.** 값은 출처(모델 카드, Comfy-Org 템플릿, ComfyUI 소스)에서 읽은 것만 적는다. 공개되지 않은 값은 비운다. 추측하거나 0을 넣지 않는다.
- **이미지 입력은 파일 이름이 아니라 참조로 받는다**(에셋 id, 첨부 id). 실행 직전에 서버의 input 폴더로 복사한다. 첨부는 쓰이는 순간 에셋이 된다.
- **생성 요청 하나가 배치 하나다.** 배치의 출력은 검토 대기로 들어오고 사용자가 채택한다. 에셋 목록의 기본은 채택된 것만이다.
- **생성 백엔드 호출은 `ComfyBackend` 구현을 통해서만 한다.** 실행 추적, 결과 수집, 취소 판정은 한 곳에서 한다.
- **`/prompt` 검증 실패는 기록을 남기지 않는다.** 큐에 아무것도 가지 않은 요청은 실행으로 치지 않는다.
- **키를 다른 출처로 보내지 않는다.** 리다이렉트는 수동으로 따라간다.
- **영상과 오디오를 에이전트에게 보일 때는 텍스트나 이미지**(프레임, 스펙트로그램)로 바꿔 넘긴다.
- **에이전트가 쓴 Blender 스크립트는 격리된 작업 서버 안에서만 실행한다.**
- **API 키는 평문으로 DB·로그·응답에 남기지 않는다.** 새 구조에서는 설정 파일과 기록도 여기에 든다.
- **도구 설명은 LLM용 영어, 사용자에게 보이는 결과 문구는 한국어다.**

새 구조에서 그대로는 서지 않는 규칙이 둘 있다.

- 첫째·둘째 규칙(직접 지우지 않는다, 직접 쓰지 않는다)은 기존 앱에서 에이전트의 도구가 우리가 만든 것뿐이라 지켜졌다. dsh의 기본 에이전트 프리셋은 셸과 파일 도구를 준다. 에이전트에게 무엇을 줄지는 미정이다(`docs/DECISIONS.md` "미정", `docs/DSH.md` "에이전트 프리셋").
- "`/prompt` 검증 실패는 기록을 남기지 않는다"는 프로젝트 계층의 실행 흐름(`pending` 기록이 서버 제출보다 먼저 추가된다)과 순서가 맞지 않는다. 2-1에서 푼다(`docs/ARCHITECTURE.md` "카탈로그 계약"의 질문 6).
