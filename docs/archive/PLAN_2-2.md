# 단계 계획 — 2-2 계약 ②: 화면용 API

`docs/ROADMAP.md` 2-2의 상세 계획이다. 브랜치는 `2-2-view-api`다(2026-11-28). 끝났다: 결과는 맨 아래 "한 것"부터 읽는다.

## 범위

DreamVerse `@dv/api`(커밋 `ec0ac62760`, 소스 8개 파일 1,304줄, 시험 6개 파일 1,396줄)를 이 저장소의 패키지 `@cs/api`로 옮기고 dsh 0.2.2-rc.5에서 실제로 돌린다. 화면(브라우저 절반)이 프로젝트를 읽고 바꾸는 유일한 길이다.

- 상태 읽기, 연산 목록과 실행·사전 확인, 기록(히스토리) 한 쪽, 실행 취소·다시 실행, stale 받아들이기, 프로젝트 관리(목록, 만들기, 이름 바꾸기, 빼기, 요약, 새 폴더), 이벤트 스트림.
- 번들에 행을 넣고, 조합 시험으로 완료 기준("브라우저에서 상태를 읽고 연산을 실행하면 이벤트가 온다")을 확인한다.
- 경로와 응답 모양을 `docs/ARCHITECTURE.md` "화면용 API"에 적는다.

범위 밖: 에셋 가져오기와 에셋 파일 내려주기(2-3의 에셋 기능 컴포넌트), 카탈로그 라우트(2-1 뒤), 브라우저 쪽 클라이언트(`DvClient`에 해당하는 것. 3-0·3-2), 화면.

## 옮기는 것과 빼는 것

DreamVerse `packages/dv/api/src/`의 모듈이다.

| 모듈 | 줄 | 판단 | 이유 |
| --- | --- | --- | --- |
| `index.ts` | 209 | 옮긴다 | 서비스, 설정, 라우트 등록. 스킬·카탈로그·에셋 가져오기 라우트는 뺀다 |
| `api.ts` | 508 | 옮긴다 | 전송과 무관한 처리기. `@dv/asset-pool` 대신 프로젝트 계층의 에셋 저장소를 읽는다 |
| `wire.ts` | 150 | 옮긴다 | 브라우저가 받는 JSON의 모양. 타임라인과 `asset.import` 기록에 기대는 부분은 뺀다 |
| `events.ts` | 62 | 옮긴다 | 이벤트 스트림. 카탈로그 변경 이벤트(`models`)는 뺀다 |
| `projects-admin.ts` | 52 | `api.ts`에 합친다 | 이름 바꾸기와 빼기 둘뿐이고 같은 요청 검증을 쓴다 |
| `summaries.ts` | 71 | 줄여 옮긴다 | 표지를 타임라인의 첫 클립에서 고르는 부분을 뺀다. 남는 규칙은 "끝난 기록의 첫 이미지 출력" |
| `asset-import.ts` | 69 | 옮기지 않는다 | `asset.import` 연산과 에셋 저장소는 에셋 기능 컴포넌트의 것이다(2-3) |
| `user-skills.ts` | 183 | 옮기지 않는다 | 스킬 묶음 업로드다. 로드맵 2-2의 범위가 아니고 의존성 둘(`fflate`, `yaml`)이 는다. 스킬 관리를 dsh에 맡길지는 1-4가 정한다 |

`@dv/api`가 주입받던 것 가운데 우리에게 없는 것과 대신하는 것:

| DreamVerse | 우리 |
| --- | --- |
| `dvAssetPool`(`has`, `get`, `importAsset`, `path`) | `ctx.csProject.assets()` — 프로젝트 계층에 등록된 에셋 저장소(`AssetStore`: `has`, `get`, `url`). 2-3 전에는 빈 저장소라 `assets`가 늘 `[]`이다. 이 접근자를 `@cs/project`에 더한다 |
| `dvCanvasNodes`(상태에 `canvas` 조각이 늘 있게 하려고 주입) | 없음. 캔버스를 둘지는 미정이다(`docs/DREAMVERSE.md`) |
| `dvModels`(`taskLabels()`, `catalog()`, `onChanged()`) | 없음. 카탈로그 계약은 2-1이 정한다 |
| `@dv/timeline`의 상태 조각(표지, 에셋 목록) | 없음 |

## 경로

접두사는 2-0에서 정해진 cs 계열을 따른다(`docs/DECISIONS.md` "확정"의 "cs 계열"): fetch 라우트는 `/api/cs/…`, 이벤트 스트림은 `/cs/events`.

| 경로 | 메서드 | 요청 | 응답 |
| --- | --- | --- | --- |
| `/api/cs/projects` | GET | — | `WireProject[]`(`{id, title, created_at, path}`), 최신순 |
| `/api/cs/projects` | POST | `{title, surface?}` 또는 `{folder, session}` | `ProjectInfo`. 앞의 것은 프로젝트 폴더 안에 새 폴더를 만들고, 뒤의 것은 채팅 세션의 폴더를 프로젝트로 만든다(surface `chat`). 같은 제목이 있으면 번호를 붙인다 |
| `/api/cs/projects/untitled` | POST | `{name}` | `{path}`: 프로젝트 폴더 안의 새 빈 폴더 |
| `/api/cs/projects/summary` | GET | `project?` | `WireProjectSummary[]`(`{project, cover, edited_at}`). 전체 목록에서는 읽지 못한 프로젝트가 빈 항목이 된다 |
| `/api/cs/projects/rename` | POST | `{project, title}` | `{title}`(겹치면 ` 2`, ` 3` …) |
| `/api/cs/projects/delete` | POST | `{project}` | `{ok}`. 목록에서 빼고 폴더는 남긴다 |
| `/api/cs/state` | GET | `project` | `WireState`(`{project, head, tip, components, assets}`) |
| `/api/cs/operations` | GET | — | `WireOperation[]`: `readOnly`가 아닌 연산의 선언 |
| `/api/cs/operation` | POST | `OperationRequest`(`{project, operation, inputs?, params?, intent?, surface?, session?, based_on?, supersedes?}`) | 기록(`ProjectRecord`). 끝났거나 `pending` |
| `/api/cs/operation/check` | POST | 위와 같다 | `{problems}`. 아무것도 쓰지 않는다 |
| `/api/cs/undo` | POST | `{project, to?}` | `{tip, at}` |
| `/api/cs/redo` | POST | `{project}` | `{tip, at}` |
| `/api/cs/stale/accept` | POST | `{project, record, session?, surface?}` | `proj.stale_accept` 기록 |
| `/api/cs/history` | POST | `{project, actor?, component?, operation?, kind?, status?, session?, turn?, tool_call?, records?, before?, limit?}` | `WireHistory`(`{entries, assets}`). `limit`은 1~200, 기본 50 |
| `/cs/events?project=<id>` | GET | — | `text/event-stream`: `ready` 뒤에 `record`, `update`, `line` |

- 우리 처리기가 내는 오류는 라우트와 스트림이 같은 본문 `{error, code, ...details}`로 답한다. `invalid_params`·`invalid_inputs`·`input_not_ready`·`read_only_operation`(400), `unknown_project`·`unknown_record`·`unknown_operation`·`unknown_asset`(404), 그 밖의 `ProjectError` 코드(409. 예: `nothing_to_undo`), `internal_error`(500. 호스트 로그에도 남긴다). 인증에서 걸린 요청(401·403)과 스트림의 GET 아닌 메서드(405)는 dsh가 답하는 꼴대로 본문이 없거나 평문이다.
- 쓰는 요청은 전부 `csProject`를 `actor: "user"`로 부른다. 기록의 `surface`는 요청의 `surface`가 `chat`이면 `chat`, 그 밖은 `view`다(`docs/DECISIONS.md` "확정"의 "글과 surface만": `view`는 우리 화면에서 한 사용자 동작).

## 인증

dsh의 것을 그대로 탄다. 우리가 따로 만드는 인증은 없다.

- fetch 라우트는 dsh `connection` 서비스의 정확 일치 라우트(`connection.fetch.register`)다. dsh가 Host·Origin 검사와 브라우저 세션 쿠키 검사를 한 뒤에 부르고, 소유자(`owner`) Peer만 닿는다(업스트림 `packages/client/connection/src/rpc-host.ts`의 `createSharedFetchHandler`, **소스 확인**).
- 이벤트 스트림은 `webServer`의 날 라우트라 dsh가 대신 검사해 주지 않는다. 그래서 요청마다 `connection.admit({ headers })`로 같은 검사를 하고, 받아들여진 Peer가 소유자일 때만 연다.
- DreamVerse와 다른 점 둘:
  - DreamVerse는 `requestRejection`만 본다(소유자인지는 보지 않는다). fetch 라우트와 같은 규칙이 되게 소유자 검사를 더했다.
  - DreamVerse는 `connection`이 없으면 스트림을 누구에게나 연다(그 README의 "Known Limitations"). 우리는 `connection`이 없으면 스트림 라우트를 등록하지 않는다.

## 고른 것

Claude가 고른 기본값이다. 사용자가 정한 것이 아니다(`docs/DECISIONS.md` "전제").

| 무엇 | 고른 것 | 이유 | 뒤집으면 |
| --- | --- | --- | --- |
| 패키지 | `packages/api`, `@cs/api`. 호스트 절반만 있다. 서비스는 `ctx.csApi`, 번들 행 id는 `cs-api` | `docs/ARCHITECTURE.md` "패키지 구성(가칭)"의 이름이고 2-0의 이름 규칙과 같다 | 이름만 바꾼다 |
| 경로 접두사 | `/api/cs/…`, `/cs/events` | 문서에 가칭으로 적혀 있던 것이고 cs 계열과 맞다 | `ROUTES`·`EVENTS_PATH` 상수와 문서를 고친다 |
| 인증 | dsh 세션 쿠키 그대로. 스트림은 소유자만 | 위 "인증" | — |
| 요청의 `surface` | `chat` 또는 `view`. 그 밖의 값은 `view`로 센다 | 프로젝트 계층의 `Surface`가 `chat`·`view`·`api`·`history`다. 화면이 보내는 것은 앞의 둘이다 | 화면별로 나누기로 하면(3-2 이후) 값을 늘린다 |
| 에셋의 모양 | `WireAsset`은 `{id, mime, name, url}`, 상태의 `assets`는 거기에 `made_by`를 더한 `ProjectAsset` | 프로젝트 계층의 `AssetStore`가 주는 것이 이만큼이다. 크기·픽셀 크기·만든 때, "가져온 에셋은 버려진 단계의 것도 남는다" 규칙은 에셋 기능 컴포넌트가 생기는 2-3에서 더한다 | 2-3에서 타입을 넓힌다(필드를 더하는 쪽이다) |
| 프로젝트 요약의 표지 | 끝난 기록의 첫 이미지 출력 | DreamVerse에서 타임라인이 없을 때의 규칙이다 | 3-0에서 프로젝트 목록을 그리며 바꿀 수 있다 |
| 설정 | `keepaliveMs`(15000, 1000 이상) 하나 | 스킬 설정 넷은 뺀 라우트의 것이다 | — |
| 코드 모양 | 2-0과 같다: Prettier, 지울 수 있는 문법만, 시험은 대상 옆 | `docs/archive/PLAN_2-0.md` "고른 것" | — |
| 시험이 쓰는 프로젝트 계층의 시험 지원 | `@cs/project`가 `./testing/support`와 `./testing/workspaces`를 내보낸다 | DreamVerse는 상대 경로로 다른 패키지의 `tests/`를 가져온다. 내보내는 쪽이 경계가 분명하다 | — |

## 시험

단위 시험(`packages/api/src/*.test.ts`)은 실제 `CsProject` 서비스를 Cordis `Context`에 올리고(작업공간 등록부와 세션은 `@cs/project`의 시험 지원이 흉내 낸다) 처리기와 라우트를 직접 부른다. DreamVerse의 시험은 영상 컴포넌트(타임라인, 샷 렌더, 캐릭터)로 상태를 만들므로 그대로 옮기지 못한다. 시험용 기능 컴포넌트(메모를 더하는 연산, 에셋을 내는 연산)로 같은 규칙을 다시 쓴다.

볼 것:

- 프로젝트 목록·상태·연산 선언(라벨은 선언했을 때만, `readOnly`는 빠진다).
- 잘못된 요청과 모르는 대상의 상태 코드와 `code`.
- 연산 실행이 `actor: "user"`, 요청의 `surface`·`session`으로 기록된다. 끝나지 않은 기록을 입력으로 받은 호출은 예약된다.
- 실행 취소·다시 실행·단계로 이동, 뒤 단계를 버리는 쓰기.
- 사전 확인이 아무것도 쓰지 않고 실행 때와 같은 문장을 준다.
- 히스토리: 전체, 필터, 쪽, 잘못된 질의.
- 프로젝트 만들기(제목 겹침, 채팅 폴더), 이름 바꾸기, 빼기, 요약(표지, 읽지 못한 프로젝트).
- 이벤트 스트림의 프레임과 `ready`, 구독 해제.
- 상태의 `assets`: 저장소가 가진 것만, `made_by`.

조합 시험(`tests/integration/api.test.ts`)은 dsh를 띄우고 브라우저 페이지 안에서 `fetch`와 `EventSource`로 부른다. 시험용 기능 컴포넌트는 패치 행으로 얹는 픽스처 플러그인(`tests/integration/fixtures/memo-component.ts`)이 등록한다.

1. `POST /api/cs/projects`로 프로젝트를 만든다.
2. `GET /api/cs/state`가 `head`와 `components`를 준다. `GET /api/cs/operations`에 시험용 연산이 있다.
3. `EventSource("/cs/events?project=…")`를 열고 `ready`를 받는다.
4. `POST /api/cs/operation`으로 연산을 실행한다. 스트림에 `record`·`update`·`line`이 오고, 다시 읽은 상태에 결과가 보인다.
5. `POST /api/cs/undo` → 상태가 되돌아가고 `line` 이벤트가 온다.
6. 쿠키 없는 요청(Node의 `fetch`)은 fetch 라우트와 스트림 모두 거절된다.

## 완료 기준

- 단위 시험이 `pnpm test`로, 조합 시험이 `pnpm test:integration`으로 통과한다.
- `pnpm check`가 통과한다.
- `pnpm -s dsh:config`에 `cs-api` 행이 보인다.
- 경로와 응답 모양이 `docs/ARCHITECTURE.md`에 있다.

## 하는 순서와 분담

| 묶음 | 내용 | 맡는 쪽 |
| --- | --- | --- |
| A | 패키지 틀과 소스(무엇을 빼고 무엇으로 대신할지가 설계 판단이다), `@cs/project`의 `assets()`와 시험 지원 내보내기, 번들 행 | 지휘 세션 |
| B | 단위 시험 | 표준 서브 에이전트 하나 |
| C | 조합 시험과 픽스처 플러그인 | 지휘 세션 |
| D | 구현과 독립된 리뷰(diff, 이 문서, 원본 소스만 준다) | 상위 서브 에이전트 하나 |
| E | 문서 | 지휘 세션 |

## 한 것

| 묶음 | 한 것 |
| --- | --- |
| A, C, E | `packages/api`(`@cs/api`)를 만들고 여섯 모듈을 옮겼다(`index.ts`, `api.ts`, `wire.ts`, `events.ts`, `summaries.ts`. `projects-admin.ts`는 `api.ts`에 합쳤다). `@cs/project`에 `assets()`와 시험 지원 내보내기를 더했다. 번들에 `cs-api` 행을 넣고 조합 시험과 픽스처 플러그인을 썼다. 문서 |
| B | 단위 시험(`api.test.ts`, `events.test.ts`, `summaries.test.ts`, `wire.test.ts`)과 시험 지원(`src/testing/support.ts`) |
| D | 리뷰와 그 지적을 고친 것(아래 "리뷰") |

## 계획과 달라진 점

- **dsh와 어긋나는 곳이 없었다.** `connection.fetch.register`, `webServer.register`, `connection.admit`이 0.2.2-rc.5에 그대로 있다. 2-0과 달리 dsh 쪽을 맞추느라 고친 곳이 없다.
- **스트림 라우트는 `exact`로 등록했다**(원본은 `prefix`). `/cs/events` 아래에 다른 경로가 없다. GET이 아닌 메서드는 인증을 보기 전에 405로 답한다.
- **프로젝트 만들기·이름 바꾸기·빼기도 `refused`를 거친다.** 상태 코드는 원본과 같다(원본은 `answer`가 같은 표로 바꿨다).
- **리뷰에서 고친 여섯 곳이 원본과 동작이 다르다**(아래 "리뷰").

## 확인한 것

2026-11-28, 이 브랜치에서 돌렸다.

- `pnpm check`의 검사(빌드, 타입, 린트, 포맷, 단위 시험 236개 가운데 화면용 API 95개)가 통과한다.
- `pnpm test:integration`의 시험 10개가 통과한다. 화면용 API의 둘(`tests/integration/api.test.ts`)이 실제 dsh에서 본 것:
  - 번들의 행으로 서비스가 올라오고, 로그인한 브라우저 페이지의 `fetch("/api/cs/…")`가 닿는다.
  - `POST /api/cs/projects`가 dsh 프로세스의 홈 아래 `comfy-studio-projects/`에 폴더를 만들고 기록 파일을 쓴다. 목록에 그 프로젝트가 보인다.
  - 연산 선언에 픽스처의 연산이 라벨과 함께 있다. 상태에 리듀서의 조각이 있다.
  - `EventSource("/cs/events?project=…")`가 열리고 `ready`가 온다. 연산을 실행하면 그 기록의 `record`, 상태가 `done`인 `update`, `line`이 온다. 다시 읽은 상태에 결과가 보인다.
  - 실행 취소와 다시 실행이 현재 위치를 옮기고 각각 `line` 이벤트 하나를 낸다. 히스토리와 요약이 맞는다.
  - 브라우저 콘솔 오류와 경고가 0건이다.
  - 쿠키 없는 요청은 fetch 라우트와 스트림 모두 401이다.
- `pnpm -s dsh:config`의 `# == @cs/bundle` 아래에 `cs-api` 행이 보인다.

확인하지 못한 것: 리버스 프록시 뒤에서 스트림이 버퍼링 없이 흐르는지(1-5), dsh가 도는 중에 `cs-project` 행의 설정이 바뀌어 서비스가 다시 실릴 때 브라우저가 스트림을 다시 잇는지(플러그인이 내려가면 열린 스트림이 끝나는 것까지는 단위 시험으로 봤다).

## 리뷰

구현과 독립된 리뷰를 상위 모델에게 맡겼다(diff, 이 문서, 원본 소스, 설치된 dsh 0.2.2-rc.5의 소스만 줬다). 원본과 모듈마다 비교한 결과 **계획에 적지 않은 동작 차이는 해롭지 않은 것뿐**이었다(위 "계획과 달라진 점"). P1은 없었다. P2 둘과 P3 여섯을 이렇게 처리했다. 여덟 가운데 여섯은 원본에서 물려받은 동작이다(`assets()`와 문서는 이 단계에서 생긴 것이다).

| 지적 | 처리 |
| --- | --- |
| P2. 동시에 온 만들기 요청 둘이 같은 제목을 받는다(빈 제목을 고르는 것이 폴더를 만들기 전이다. 재현됐다) | 만들기를 한 번에 하나씩 한다(`ApiHandlers.createProject`가 앞의 만들기를 기다린다). 실패한 만들기는 다음 것을 막지 않는다. 시험을 더했다. **원본과 다르다** |
| P2. 플러그인이 내려가도 열린 스트림이 남고, 옛 구독에 묶여 조용해진다(keep-alive가 계속 가서 브라우저가 다시 잇지 않는다. 앞 절반이 재현됐다) | 서비스가 열린 스트림을 들고 있다가 라우트를 뺄 때 모두 끝낸다. 브라우저의 `EventSource`가 다시 잇는다. 시험을 더했다. **원본과 다르다** |
| P3. 입력 역할 이름이 `constructor`·`__proto__` 같으면 500이 난다(재현됐다) | 역할을 `Map`으로 모은다. 프로젝트 계층의 `parseInputs`도 연산의 자기 열쇠만 본다(에이전트 도구 호출에서 그런 역할이 아는 역할로 통하던 것을 같이 막았다). 400 `invalid_inputs`다. **원본과 다르다** |
| P3. 폴더가 될 수 없는 이름(NUL, 너무 긴 이름)과 없는 폴더가 절대 경로가 든 500이 된다(재현됐다) | 제목·폴더 이름은 제어 문자가 없고 200바이트 이하여야 한다. 없는 폴더는 400 `invalid_params`다. 500은 호스트 로그에 남긴다. **원본과 다르다** |
| P3. 읽기 전용 연산을 실행 라우트로 부르면 연산이 돌고 나서 400이 나고, 사전 확인은 문제없다고 답한다(재현됐다) | 실행 요청을 만들 때 거절한다(400 `read_only_operation`). 연산이 돌지 않고, 사전 확인이 같은 문장을 문제로 준다. **원본과 다르다** |
| P3. `assets()`가 쓸 수 있는 저장소(`importAsset`)까지 내준다 | 읽기 셋(`has`, `get`, `url`)만 가진 객체를 준다(`AssetReader`). "에셋은 연산 실행으로만 들어온다"가 타입이 아니라 값으로 지켜진다 |
| P3. `keepaliveMs`가 0이나 음수를 받는다. 읽지 않는 클라이언트의 버퍼가 끝없이 는다 | `keepaliveMs`는 1000 이상이다. 버퍼가 4MiB를 넘으면 스트림을 끝낸다(브라우저가 다시 잇고 상태를 다시 읽는다). **원본과 다르다** |
| P3. 문서와 시험이 어긋난 곳: 조합 시험이 `update`를 단언하지 않는데 문서가 띄워 확인했다고 적었다. `line` 둘만 남는다는 단언이 `update`가 늦게 오면 깨질 수 있다. 인증에서 걸린 요청의 본문이 JSON이 아니다. 픽스처 파일 이름 | 조합 시험이 상태가 `done`인 `update`를 기다리고 단언한다. 문서를 고쳤다 |

고치지 않은 것: 스트림의 인증을 열 때 한 번만 본다(브라우저 세션이 끊겨도 열린 스트림은 남는다). dsh의 다른 연결도 같은 방식이고 스트림은 플러그인과 함께 끝난다. `{folder}`로 만드는 프로젝트는 있는 폴더라면 어느 것이든 받는다. 원본의 동작이고, 소유자만 부를 수 있으며, 채팅이 도는 폴더를 프로젝트로 만드는 길이다.

PR의 리뷰 봇(Codex)은 P2 한 건을 냈다. 옮긴 원본의 코드에 대한 것이고 재현되는 지적이라 고쳤다(`AGENTS.md` "PR 리뷰 봇 지적 대응 기준"). **원본과 동작이 달라진 곳이다.**

| 지적 | 처리 |
| --- | --- |
| 제목 끝의 숫자가 안전한 정수 범위를 넘으면(`Test 9007199254740992`) 같은 제목으로 한 번 더 만들 때 번호를 올리는 반복문이 끝나지 않는다. 2^53을 넘으면 1을 더해도 값이 그대로다. 동기 반복문이라 서버 전체가 멈춘다 | 제목 끝의 숫자를 번호로 보는 것은 아홉 자리까지다(`freeTitle`). 그보다 길면 이름의 일부로 보고 뒤에 ` 2`부터 붙인다. 번호가 정확한 정수 범위를 벗어날 수 없다. 프로젝트 계층의 두 반복문(새 폴더, 이름 바꾸기)은 1이나 2에서 시작해 있는 것의 수만큼만 돌아 해당하지 않는다. 시험을 더했다 |
