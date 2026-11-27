# 단계 계획 — 4-0 연동 라이브러리 이식

`docs/ROADMAP.md` 4-0의 상세 계획이다. 브랜치는 `4-0-comfy-lib`다(2026-11-28).

## 범위

기존 `comfy-studio`의 ComfyUI 연동 라이브러리(`src/lib/comfy`)를 이 저장소의 패키지 `@cs/comfy`로 옮긴다. dsh에 의존하지 않는 순수 라이브러리다. 계획 4의 나머지(서버 등록 4-1, 생성 프로바이더와 실행 4-2)와 계획 2의 워크플로·생성 기능 컴포넌트(2-3)가 이 패키지의 함수를 쓴다.

- `src/lib/comfy`에서 `runner.ts`와 `input-image.ts`를 뺀 소스 21개 파일(5,108줄)과 그 테스트 18개.
- 같이 서야 하는 보조 모듈: `media/png-text.ts`, `presets/match.ts`, `storage/sigv4.ts`, `storage/keys.ts`와 그 테스트 셋. 그리고 `media/png-text.server.ts`(13줄. `png-text.test.ts`가 가져온다. `docs/LEGACY.md`의 목록에 빠져 있었다).
- 테스트 픽스처 하나: `media/__fixtures__/comfy-output.png`(1,543바이트).

범위 밖: `runner.ts`(앱 서비스에 묶여 있어 4-2에서 프로젝트 계층에 맞춰 새로 쓴다), `input-image.ts`와 `runner` 테스트 둘(4-2), 서버 등록과 키 저장(4-1), 카탈로그에 꽂는 프로바이더(4-2).

## 옮기는 것

기존 저장소의 `src/lib/` 아래 경로와 새 자리(`packages/comfy/src/` 아래)다.

| 기존 | 새 자리 | 내용 |
| --- | --- | --- |
| `comfy/backend.ts` | `backend.ts` | `ComfyBackend` 인터페이스(서버 종류 넷을 가린다), `ComfyError`, 출력 크기 상한 |
| `comfy/client.ts` | `client.ts` | ComfyUI HTTP 구현(local, Comfy Cloud). WebSocket, `/view` 리다이렉트를 수동으로 따라가기 |
| `comfy/protocol.ts` | `protocol.ts` | 응답 파서(WebSocket 프레임, `/history`, Cloud 작업 상태, 출력 분류, 모델 메타데이터) |
| `comfy/workflow.ts` | `workflow.ts` | API 형식 그래프, 필드 추론과 값 적용 |
| `comfy/graph-patch.ts`, `graph-diff.ts`, `graph-text.ts` | 같은 이름 | 그래프 패치 연산과 검증, 두 그래프의 차이, 에이전트가 읽는 그래프 표현 |
| `comfy/node-catalog.ts`, `readiness.ts` | 같은 이름 | 노드 카탈로그 캐시와 검색, 준비 점검 |
| `comfy/model-families.ts`, `family-checks.ts`, `family-text.ts`, `model-loaders.ts` | 같은 이름 | 모델 계열 13개의 규칙, 계열 경고, 계열 설명 글, 모델 로더 표 |
| `comfy/embedded-graph.ts`, `handoff.ts`, `events.ts` | 같은 이름 | PNG에 든 그래프 꺼내기, 갤러리 이미지를 필드로 넘기는 열쇠, 진행 이벤트의 모양 |
| `comfy/runpod/*` | `runpod/*` | RunPod Serverless 구현(작업 API, 네트워크 볼륨의 S3 호환 API) |
| `comfy/modal/client.ts` | `modal/client.ts` | Modal 게이트웨이 구현 |
| `media/png-text.ts`, `png-text.server.ts` | `support/png-text.ts`, `support/png-text.server.ts` | PNG 텍스트 청크 읽기 |
| `presets/match.ts` | `support/match.ts` | 모델 파일 이름 패턴 매칭 |
| `storage/sigv4.ts`, `storage/keys.ts` | `support/sigv4.ts`, `support/keys.ts` | SigV4 서명, 저장 열쇠 검사 |

## 사용자가 정할 것: 공개 범위

기존 저장소는 비공개이고 이 저장소는 공개다. 코드와 테스트 픽스처를 옮기기 전에 공개해도 되는지 사용자가 확인한다(`docs/DECISIONS.md` "전제", `AGENTS.md` "꼭 지킬 것"). 푸시는 그 확인 뒤에 한다.

옮긴 파일 47개와 픽스처를 두 번 점검했다(2026-11-28). 지휘 세션이 스크립트로 IPv4 주소, URL, 이메일, 키처럼 보이는 문자열, 계정 이름, 홈 경로, 호스트 이름을 찾아 걸린 곳을 읽었고, 구현과 독립된 리뷰가 주석과 테스트 값까지 전부 읽었다.

- **실제 키, 토큰, 이메일, 사설 주소, 홈 경로는 없다.** 걸린 값은 전부 예시다: AWS 문서의 예제 키(`sigv4.test.ts`), 루프백 주소, 지어낸 호스트(`http://gpu:8188`, `https://c.example`, `https://storage.example`), 공개 서비스의 주소(`cloud.comfy.org`, `api.runpod.ai`, 모델 계열의 출처 URL).
- **PNG 픽스처**는 8×8 이미지이고 텍스트 청크 둘(`prompt`, `workflow`)에 ComfyUI의 기본 예제 그래프가 들어 있다. 다른 청크와 뒤에 붙은 바이트가 없다. 개인 데이터가 없다.
- **운영 데이터, 사용 판단, OAuth 구독 프로바이더의 이름은 없다.**
- **특정 배포를 가리키는 이름과 값은 일반 이름으로 바꿨다.** RunPod·Modal 구현의 주석과 테스트 값에 있던 것이다: 컨테이너 이미지 이름, 워커와 게이트웨이의 저장소·앱·함수·볼륨 이름, 게이트웨이 주소의 앱 이름과 지역, GPU 프로필 이름과 장치 이름, 출력 경로와 날짜, 데이터센터 id. 테스트는 그 값이 그대로 지나가는지만 보므로 뜻이 바뀌지 않는다.
- **이름을 바꿔도 코드로 남는 것**: RunPod·Modal 구현은 공식 ComfyUI API가 아니라 별도 워커와 게이트웨이의 규약을 따른다. 요청과 응답의 모양, 볼륨 안의 경로, 게이트웨이의 라우트 목록(파일을 올리고 지우는 라우트 포함)이 코드에 그대로 있다. 주소와 토큰은 코드에 없다.

보일 안:

| 안 | 내용 |
| --- | --- |
| **이름만 일반화해서 전부 공개(권함)** | 47개 파일을 모두 옮긴다. 지금 브랜치의 상태다 |
| local·cloud만 공개 | `runpod/`와 `modal/`(파일 10개), 그것만 쓰는 `support/sigv4.ts`·`support/keys.ts`·`support/short-id.ts`를 빼고 옮긴다. 공식 ComfyUI API를 쓰는 부분만 남는다. RunPod·Modal은 4-3에서 다시 정한다 |
| 공개하지 않는다 | 이 단계를 멈춘다. 연동 라이브러리를 새로 쓰거나 공개하지 않는 패키지로 두는 길을 따로 정한다(`docs/DECISIONS.md` "전제"의 "뒤집히면") |

**정해졌다(2026-11-28)**: 사용자가 "전부 공개"를 골랐다(`docs/DECISIONS.md` "확정").

## 고른 것

Claude가 고른 기본값이다. 공개 범위와 함께 사용자에게 보인다.

| 무엇 | 고른 것 | 이유 | 뒤집으면 |
| --- | --- | --- | --- |
| 패키지 | `packages/comfy`, `@cs/comfy`. dsh에 의존하지 않는다. 번들의 행이 없다(플러그인이 아니다) | `docs/ARCHITECTURE.md` "패키지 구성(가칭)"의 이름이다 | 이름만 바꾼다 |
| 내보내기 | 모듈마다 하위 경로로 내보낸다(`@cs/comfy/workflow`, `@cs/comfy/graph-patch` …). 모아 내보내는 진입점은 두지 않는다 | 기존 코드가 모듈마다 가져다 쓴다. 브라우저 절반이 순수 모듈(`workflow`, `graph-patch`)만 가져갈 때 Node 전용 모듈(`client`, `runpod/volume`)이 딸려 오지 않는다 | `index.ts`를 더한다 |
| 파일 구성 | `comfy/`의 파일은 `src/` 바로 아래에, 보조 모듈 넷은 `src/support/`에 둔다. 테스트는 대상 옆 그대로다 | 보조 모듈은 이 패키지 안에서만 쓰인다 | 폴더만 옮긴다 |
| 앱에서 타입만 가져오던 곳 | `src/types.ts`에 그 값 집합을 둔다: 서버 종류, 생성 상태, 에셋 종류, 미디어 종류, `GraphModelFamily`. 기존 `db/schema`, `attachments/media`, `model-meta/types`에서 온 것이다 | 라이브러리가 앱 없이 서려면 자기 것이어야 한다 | — |
| `events.ts`의 스트림 이벤트 | `GenerationSseEvent<View>`로 바꾼다(생성 하나를 보이는 모양 `View`는 부르는 쪽이 정한다) | 기존 타입은 앱의 DB 뷰(`GenerationView`)를 품고 있었다. 새 구조의 생성 모양은 2-3·4-2가 정한다 | 4-2에서 다시 정한다 |
| `nanoid` | 의존성을 더하지 않고 `node:crypto`로 같은 글자 집합의 6자 id를 만든다(`support/short-id.ts`) | 쓰는 곳이 업로드 파일 이름의 접미사 두 곳뿐이다. 새 의존성은 꼭 필요할 때만 더한다(`AGENTS.md`) | `nanoid`를 의존성으로 더한다 |
| `zod` | 이 저장소가 쓰는 4.6.6(기존 앱은 4.6.7) | `@cs/project`와 같은 버전이고 dsh의 공유 모듈 줄(4.6.x)이다 | — |
| `server-only` | 지운다(다섯 파일의 import와 테스트의 흉내) | Next.js의 장치다. `node:` 모듈을 가져오는 파일(`runpod/*`, `modal/*`, `support/sigv4.ts`)은 브라우저 번들 빌드가 막는다. `client.ts`는 `node:` 모듈을 가져오지 않아 빌드가 막지 않는다. 브라우저 절반에서 가져오지 않는 것은 규칙으로 지킨다 | — |
| 코드 모양 | 2-0·2-2와 같다: 상대 import에 `.ts`, 지울 수 있는 문법만(생성자 매개변수 속성 10곳을 필드 선언으로 푼다), Prettier, oxlint | 이 저장소의 규칙이다 | — |
| 린트 | 타입 단언은 좁히기로 바꾸고, 못 바꾸는 곳은 이유를 적고 그 줄에서만 끈다. 테스트의 단언은 `src/testing/support.ts`의 도우미 둘로 모은다. ComfyUI의 필드 이름 `_meta`만 `no-underscore-dangle`에서 허용한다(`.oxlintrc.json`) | 2-0에서 정한 방식이다. `_meta`는 ComfyUI 그래프의 필드라 이름을 바꿀 수 없다 | — |
| 프로세스 전역 캐시의 열쇠 | `globalThis`의 열쇠 이름에서 앞의 밑줄을 뗀다(`csComfyNodeCatalogs` 등) | 린트가 밑줄로 시작하는 이름을 막는다. 캐시의 수명은 그대로다 | — |
| 오류 메시지 | 한국어 그대로 둔다(`ComfyError`) | 사용자에게 보이는 문구다(`docs/LEGACY.md` "유지할 도메인 규칙") | — |

## 완료 기준

- 옮긴 테스트가 `pnpm test`로 통과한다. 뺀 테스트가 있으면 이유와 함께 적는다.
- `pnpm check`가 통과한다.
- `@cs/comfy`의 `package.json`에 `@deepseek-ai/*` 의존이 없다.
- 공개 범위를 사용자가 확인했다.

## 하는 순서와 분담

| 묶음 | 내용 | 맡는 쪽 |
| --- | --- | --- |
| A | 복사와 import 고치기(스크립트), 패키지 틀, 타입 모듈, 공개 여부 점검 | 지휘 세션 |
| B | 이 저장소의 린트와 지울 수 있는 문법에 맞추기. 파일이 겹치지 않는 세 묶음(ComfyUI 클라이언트와 파서 / RunPod·Modal·보조 모듈 / 그래프·모델 계열·카탈로그) | 표준 서브 에이전트 셋, 병렬 |
| C | 구현과 독립된 리뷰(원본과의 동작 차이, 공개하면 안 되는 내용) | 상위 서브 에이전트 하나 |
| D | 문서 | 지휘 세션 |

## 결과

2026-11-28에 옮겼다.

- `packages/comfy`(`@cs/comfy`)에 파일 47개(소스 21, 테스트 18, 보조 모듈 다섯과 그 테스트 셋)와 PNG 픽스처 하나가 있다. 새로 쓴 파일은 셋이다: `src/types.ts`, `src/support/short-id.ts`, `src/testing/support.ts`.
- 옮긴 테스트 21개 파일 253개가 전부 통과한다. 뺀 테스트가 없다. 파일마다 테스트 수와 기대값의 수가 원본과 같다(독립 리뷰가 셌다). 저장소 전체의 단위 시험은 489개다.
- `pnpm check`가 통과한다. `@cs/comfy`의 의존은 `zod`와 Node 내장 모듈뿐이다.
- 번들과 플러그인에 닿지 않으므로 조합 시험은 대상이 아니다.

### 원본과 달라진 동작

옮기면서 동작을 바꾸지 않는 것이 목표였다. 원본을 그대로 복사한 것과 나란히 돌려 비교했고(독립 리뷰), 다른 곳은 둘이다. 둘 다 고치지 않고 둔다.

| 자리 | 달라진 것 | 판단 |
| --- | --- | --- |
| `client.ts`의 `formatNodeErrors` | 서버가 `node_errors`의 항목이나 그 안의 오류를 `null`로 주면 원본은 `TypeError`를 던졌다. 이제 읽을 수 있는 `ComfyError`가 된다 | 타입 단언을 좁히기로 바꾼 결과다. 나아진 쪽이다 |
| `workflow.ts`의 `coerceParamValue` | 필드 종류가 목록에 없는 값이면 원본은 `undefined`를 돌려줬다. 이제 숫자로 다룬다 | 필드는 스키마(`z.enum(PARAM_TYPES)`)를 거쳐 들어오므로 닿지 않는 경로다 |

`nanoid(6)`을 바꾼 `shortId(6)`은 같은 64자 집합에서 고르게 뽑는다(독립 리뷰가 120만 자로 확인했다).

### 리뷰에서 나온 것

구현과 독립된 리뷰(상위 등급)를 한 번 받았다. 코드에는 고칠 것(P1·P2)이 없었다. 공개 점검에서 나온 이름과 값은 위 "공개 범위"대로 바꿨다.

| 지적 | 처리 |
| --- | --- |
| 이미지 이름, 워커·게이트웨이의 이름, GPU 프로필, 출력 경로, 데이터센터 id가 특정 배포를 가리킨다 | 일반 이름으로 바꿨다 |
| 이 문서가 `server-only` 대신 빌드가 막는다고 적었는데 `client.ts`는 막히지 않는다 | "고른 것"의 설명을 고쳤다 |
| 테스트 도우미 `defined()`를 쓰는 곳이 없다 | 지웠다 |
| 내보내기 `./*`가 테스트 파일과 `testing/`도 내보낸다 | 그대로 둔다. 가져다 쓰는 곳이 없다. 쓰는 쪽이 생기는 4-1·4-2에서 내보낼 모듈을 좁힐지 본다 |
| 주석 몇 곳이 기존 앱의 모듈(`lib/comfy-servers.service` 등)을 가리킨다 | 그대로 둔다. 그 자리를 대신할 모듈이 4-1·4-2에서 생길 때 고친다 |

### 남긴 것

- 주석이 가리키는 기존 앱의 모듈 이름(4-1, 4-2).
- `events.ts`의 `GenerationSseEvent<View>`와 `types.ts`의 생성 상태는 4-2가 실행기를 쓸 때 다시 본다.
