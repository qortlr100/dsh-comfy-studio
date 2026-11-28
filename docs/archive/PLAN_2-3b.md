# 2-3b 단계 계획 — 에셋

2-3의 둘째 갈래다. 프로젝트의 에셋(이미지, 영상, 오디오, 그 밖의 파일)을 맡는 기능 컴포넌트 `@cs/asset`과, 그것이 쓰는 ffmpeg 서비스 `@cs/ffmpeg`을 만든다. 2-3 전체에 걸리는 결정은 `docs/archive/PLAN_2-3a.md`에 있다.

- 저장소(파일을 프로젝트 폴더에 두는 부분)와 ffmpeg 서비스는 DreamVerse `@dv/asset-pool`·`@dv/ffmpeg`(커밋 `ec0ac62760`, MIT)을 옮겨 고친다.
- 폴더, 태그, 검토 상태, 삭제, 목록은 새로 쓴다. 기존 앱의 동작이 본이고 코드는 옮기지 않는다(사용자가 정함, 2026-11-28).

## 패키지

| 패키지 | 서비스 | 번들 행 | 내용 |
| --- | --- | --- | --- |
| `@cs/ffmpeg`(`packages/ffmpeg`) | `ctx.csFfmpeg` | `cs-ffmpeg` | ffmpeg·ffprobe를 실행하는 한 곳. 연산이 없다 |
| `@cs/asset`(`packages/asset`) | `ctx.csAsset` | `cs-asset` | 에셋 저장소, 리듀서, 연산, 파일을 내려주는 라우트 |

`@cs/asset`은 `csProject`를 주입받고, `csFfmpeg`과 dsh의 `connection`은 있으면 쓴다(없으면 크기·길이·썸네일과 라우트가 없다).

## 파일이 사는 곳

```
<프로젝트 폴더>/.comfy-studio/assets/objects/<sha256>   바이트. 한 번 쓰고 고치지 않는다
<프로젝트 폴더>/.comfy-studio/assets/index.jsonl        에셋마다 한 줄(뒤의 줄이 이긴다). 추가만 한다
<프로젝트 폴더>/.comfy-studio/assets/thumbs/<sha256>.webp   썸네일. 지워도 다시 만든다
```

- 에셋 id는 바이트의 SHA-256이다(프로젝트 계층의 `AssetId`). 같은 파일을 한 프로젝트에 두 번 넣으면 에셋 하나다. 같은 바이트가 두 프로젝트에 있으면 파일은 둘이고 id는 하나다.
- `.comfy-studio/` 가운데 `records.jsonl`과 `line.json`은 프로젝트 계층만, `assets/`는 에셋 기능 컴포넌트만 읽고 쓴다.
- 파일로 넣을 때는 전체를 메모리에 올리지 않는다: 조각으로 읽어 해시를 내고 `objects/<id>.partial`로 복사한 뒤 이름을 바꾼다.
- 색인의 한 줄: `{id, mime, name, size_bytes, created_by, created_at, width, height, duration_sec, has_audio?}`.
- 크기와 길이는 ffprobe가 있으면 가져올 때 읽어 색인에 덧붙인다. 실패하면 경고만 남긴다.

## 상태 조각

`ComponentStates.asset`. 타입과 선택자는 `@cs/asset/types`에 두고 브라우저 절반이 타입으로 읽는다(호스트 모듈을 가져오지 않는다).

```ts
export type AssetReview = "pending" | "adopted" | "held";
export type AssetKind = "image" | "video" | "audio" | "file";

/** One asset of the project's library. */
export interface AssetItem {
  id: AssetId;
  /** `import`: a person brought the file in. `output`: an operation made it. */
  origin: "import" | "output";
  /** The record that first brought the asset into the library. */
  record: RecordId;
  /** When that record was written (ISO-8601 UTC). */
  added_at: string;
  review: AssetReview;
  /** When `review` was last set by a person; absent while it is the default of the origin. */
  reviewed_at?: string;
  /** The folder; null for the project root. */
  folder: RecordId | null;
  /** Lower-case tags, sorted. */
  tags: string[];
}

/** One folder. Its ID is the record that created it. */
export interface AssetFolder {
  id: RecordId;
  name: string;
  parent: RecordId | null;
  /** Order among siblings, 0 first. */
  position: number;
}

export interface AssetSlice {
  /** The assets in the library now. A deleted asset is not here. */
  items: Record<AssetId, AssetItem>;
  folders: Record<RecordId, AssetFolder>;
  /** Marks of assets that are not in `items`: see the reducer rules. Views ignore it. */
  marks: Record<AssetId, AssetMark>;
}

/** What steps said about an asset that is not in the library (yet, or any more). */
export interface AssetMark {
  review?: AssetReview;
  reviewed_at?: string;
  folder?: RecordId | null;
  tags?: string[];
  /** When a step deleted the asset. */
  deleted_at?: string;
}
```

### 리듀서 규칙

리듀서는 히스토리의 기록을 차례로 받은 **뒤에** 히스토리 밖의 `asset.import` 기록을 쓴 순서로 받는다. 그래서 가져오기보다 나중에 일어난 단계(태그, 삭제)를 가져오기보다 먼저 본다. 규칙은 이 순서에서도 실제 시각 순서와 같은 결과를 내야 한다. 시각은 기록의 `created_at`이다.

1. **끝난 기록의 출력**(어느 컴포넌트의 기록이든 `status: "done"`이고 `outputs`가 있다. `asset.import`는 뺀다): 출력마다 `items`에 없으면 넣는다. `origin: "output"`, `review: "pending"`, `folder: null`, `tags: []`. 이미 있으면 그대로 둔다. `marks`에 그 id가 있으면 지운다(히스토리 순서상 그 표시는 앞의 것이다).
2. **`asset.review`**(`params.review`): 입력 에셋마다 `review`와 `reviewed_at`을 쓴다. `items`에 없으면 `marks`에 쓴다.
3. **`asset.move`**, **`asset.tag`**: 같다. `items`에 없으면 `marks`에 쓴다.
4. **`asset.delete`**: 입력 에셋을 `items`에서 빼고 `marks[id] = { deleted_at }`만 남긴다(다른 표시는 버린다).
5. **`asset.folder_create`·`_update`·`_delete`**: 폴더 표를 고친다. 지우면 하위 폴더까지 지우고, 그 안에 있던 에셋과 `marks`의 `folder`는 `null`(루트)이 된다.
6. **`asset.import`**(히스토리 밖, 시각 `T`): 출력마다
   - `items`에 없고 `marks`에도 없으면: 넣는다. `origin: "import"`, `review: "adopted"`.
   - `marks`에 있으면: `deleted_at`이 `T`보다 뒤면 그대로 둔다(가져온 뒤에 지운 것이다). 아니면 넣는다. 표시의 `folder`와 `tags`를 옮기고, 표시의 `reviewed_at`이 `T`보다 뒤면 그 `review`를, 아니면 `adopted`를 쓴다. 표시를 지운다.
   - `items`에 있으면(연산의 출력이었다): `reviewed_at`이 `T`보다 앞이거나 없으면 `review: "adopted"`, `reviewed_at: T`로 한다. `origin`은 그대로 둔다.
7. 그 밖의 기록은 조각을 바꾸지 않는다. 리듀서는 던지지 않는다: 모양이 틀린 `params`는 건너뛴다.

실행 취소는 따로 다루지 않는다. 리듀서가 현재 위치까지의 기록만 받으므로, 취소된 단계가 만든 출력과 표시는 저절로 빠진다. 가져온 에셋은 히스토리 밖이라 남는다(DreamVerse의 히스토리 규칙 4).

기본 검토 상태: 사람이 가져온 것은 `adopted`, 연산이 만든 것은 `pending`이다. 컴포넌트 이름을 보지 않는다(기능 컴포넌트는 다른 기능 컴포넌트를 이름으로 알지 않는다). 생성의 출력이 검토 대기로 들어오고 사용자가 채택한다는 기존 규칙이 이것으로 선다.

## 연산

전부 `component: "asset"`, `version: "1"`, `resource: "none"`, `deterministic: false`다.

| 연산 | `agent` | 입력 | 파라미터 | 하는 일 |
| --- | --- | --- | --- | --- |
| `asset.import` | `none` | `file`(여럿, 필수) | — | 저장소에 있는 바이트를 이 프로젝트의 에셋으로 들인다. 히스토리 밖이다. 다른 프로젝트 폴더에만 있는 바이트면 이 프로젝트로 복사한다. 출력은 입력과 같은 id들이다 |
| `asset.review` | `none` | `asset`(여럿, 필수) | `review`: `adopted` \| `held` | 채택하거나 보류한다. 사용자만 한다 |
| `asset.move` | `run` | `asset`(여럿, 필수) | `folder?`(폴더 id. 없으면 루트) | 폴더로 옮긴다 |
| `asset.tag` | `run` | `asset`(여럿, 필수) | `add?`, `remove?`(문자열 목록) | 태그를 붙이고 뗀다 |
| `asset.delete` | `propose` | `asset`(여럿, 필수) | — | 라이브러리에서 뺀다. 파일은 남는다 |
| `asset.folder_create` | `run` | — | `name`, `parent?` | 폴더를 만든다. id는 이 기록의 id다 |
| `asset.folder_update` | `run` | — | `folder`, `name?`, `parent?`(`null`이면 루트) | 이름을 바꾸거나 옮긴다 |
| `asset.folder_delete` | `propose` | — | `folder` | 폴더와 하위 폴더를 지운다. 안의 에셋은 루트로 간다 |
| `asset.list` | 읽기(`readOnly`) | — | `folder?`, `review?`, `kind?`, `q?`, `tags?`, `limit?`, `cursor?` | 라이브러리를 읽는다 |

`precondition`(기록 전 거절, `ProjectError`):

- 입력 에셋은 `items`에 있어야 한다(`asset.import`만 예외: 저장소에 있으면 된다). 없으면 `invalid_inputs`.
- 폴더: 이름은 다듬은 뒤 1~100자이고 `/`와 `\`가 없다. 형제끼리 대소문자 없이 겹치지 않는다. 깊이는 4까지다(옮길 때는 하위 폴더의 높이까지 센다). 자기 자신이나 자기 하위로 옮기지 못한다. 없는 폴더 id는 `invalid_params`.
- 태그: 다듬고 소문자로 바꾼 뒤 1~40자이고 쉼표가 없다. `add`와 `remove`는 각각 20개까지이고 둘 중 하나는 있어야 한다. 한 에셋의 태그는 50개까지다.
- `asset.review`의 `review`는 `adopted`나 `held`다.

`asset.list`의 답(`report`):

```ts
{ items: Array<{ id, name, kind, mime, folder: string | null /* 경로 "상위/하위" */, review, tags, origin,
                 record, made_by: string | null /* 만든 도구 이름 */, added_at, url }>,
  next_cursor: string | null }
```

- 기본은 `review: "adopted"`만이다. 최신순(`added_at`, 같으면 id)이고 `limit`은 1~100, 기본 30이다.
- `folder`는 폴더 id나 `root`(폴더에 없는 것)다. 주지 않으면 모든 폴더다. 하위 폴더는 넣지 않는다.
- `q`는 공백으로 나눈 낱말(8개까지) 전부가 이름, 태그, 만든 기록의 `intent`와 `params`의 글 가운데 하나에 대소문자 없이 들어 있어야 한다.
- `tags`는 전부 가진 것만(5개까지).

에이전트 요약(`agentSummary`): `assets`(`{adopted, pending, held}` 개수)와 `asset_folders`(`[{id, path}]`, 40개까지. 넘으면 `asset_folders_more`에 남은 수). 값이 없으면 칸을 넣지 않는다.

도구 설명은 영어로 새로 쓴다. 에이전트가 알아야 할 것: 연산의 출력은 검토 대기로 들어오고 사용자가 채택한다, 채택과 보류는 사용자만 한다, 삭제는 제안이다, 폴더가 정리의 중심이고 태그는 찾기를 돕는다.

## 라우트

`@cs/asset`이 dsh `connection`의 fetch 라우트로 직접 등록한다(인증은 dsh가 한다. 소유자만 닿는다). 화면용 API(`@cs/api`)는 기능 컴포넌트를 모른다.

| 경로 | 메서드 | 요청 | 응답 |
| --- | --- | --- | --- |
| `/api/cs/asset` | GET, HEAD | `id`, `download?` | 바이트. `Range: bytes=a-b` 하나를 받는다(206, `Content-Range`). `Accept-Ranges: bytes` |
| `/api/cs/asset/thumb` | GET, HEAD | `id` | 512px 안에 드는 WebP. 이미지와 영상만. 만들 수 없으면 404 |
| `/api/cs/asset/upload` | POST | 쿼리 `project`, `name`, `mime`, `folder?`, `session?`, `surface?`. 본문은 파일의 바이트(스트림) | `{asset, record}`: 바이트를 저장소에 넣고 `asset.import`를 사용자로 실행한다. `folder`를 주면 이어서 `asset.move`도 실행한다 |
| `/api/cs/asset/stage` | POST | 쿼리 `project`, `name`, `mime`. 본문은 파일의 바이트(스트림) | `{asset}`: 바이트를 저장소에 넣기만 한다. 라이브러리에는 들어가지 않는다. 다른 기능 컴포넌트의 연산이 그 id를 입력으로 받는다(워크플로 파일, 2-3c) |

- 헤더: `Cache-Control: private, max-age=31536000, immutable`(id가 내용이다), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`.
- **화면에 바로 그려도 되는 종류만 제 종류로 준다**: `image/png`·`jpeg`·`webp`·`gif`·`avif`, `video/mp4`·`webm`·`quicktime`, `audio/mpeg`·`wav`·`flac`·`ogg`·`opus`·`mp4`·`aac`. 그 밖(HTML, SVG 포함)은 `application/octet-stream`에 `Content-Disposition: attachment`다. 같은 출처에서 스크립트가 도는 것을 막는다.
- 오류 본문은 화면용 API와 같은 꼴이다: `{error, code}`. 없는 id는 404(`unknown_asset`), 틀린 Range는 416.
- 올리기는 본문을 임시 파일로 받아 해시를 내며 저장소로 옮긴다. 한도는 설정 `maxUploadBytes`(기본 2GiB)이고 넘으면 413이다. `mime`이 없으면 400이다.
- `AssetStore.url(id)`는 `/api/cs/asset?id=<id>`다(설정 `publicBaseUrl`이 있으면 앞에 붙는다).

## 프로젝트 계층과 화면용 API에 더하는 것

- `AssetStore.get`이 돌려주는 값에 선택 칸을 더한다: `size_bytes`, `width`, `height`, `duration_sec`, `created_at`, `thumb_url`. 화면용 API의 `WireAsset`이 그대로 싣는다(2-2의 후속).
- `Reducer.mentions?(slice): AssetId[]`: 조각이 가리키는 에셋. 화면용 API가 상태의 `assets`를 모을 때 `proj`의 것에 더한다. 가져온 에셋은 히스토리 밖이라 `proj`의 기록에 없다.
- 번들에 `cs-ffmpeg`, `cs-asset` 행을 넣는다. `cs-ffmpeg`의 `ffmpegPath`·`ffprobePath`는 환경 변수 `CS_FFMPEG_PATH`·`CS_FFPROBE_PATH`에서 읽고 없으면 `PATH`의 `ffmpeg`·`ffprobe`다.

## 하지 않는 것

- 쓰이지 않는 에셋 파일의 정리. 삭제와 보류는 상태에서만 일어나고 파일은 남는다(실행 취소로 되돌릴 수 있다). 기존 앱은 보류한 지 3일이 지난 파일을 지웠다. 파일을 실제로 지우는 일은 스토리지(2-8)에서 본다.
- 에이전트가 이미지를 보는 도구(기존 `view_image`)와 영상·오디오 검수. 2-6이다.
- 채팅 첨부가 에셋이 되는 것. 2-5다.
- 비교 화면, 갤러리. 3-2다.
- PNG에 든 생성 정보 읽기. 워크플로 가져오기(2-3c)와 함께 본다.

## 고른 것

Claude가 고른 기본값이다.

| 고른 것 | 이유 | 뒤집으면 |
| --- | --- | --- |
| 에셋 파일은 `.comfy-studio/assets/`에 둔다 | DreamVerse의 자리다. 이름이 해시라 사람이 열어 볼 폴더가 아니다. 프로젝트 폴더를 복사하면 프로젝트 전체가 간다 | 경로 상수 하나 |
| 가져오기만 히스토리 밖이고 나머지는 단계다 | 가져온 파일이 실행 취소로 사라지면 안 된다(히스토리 규칙 4). 폴더·태그·검토·삭제는 프로젝트 내용의 변경이라 되돌릴 수 있어야 한다 | `asset.import`의 `outsideHistory`를 뺀다 |
| 연산의 출력은 어느 컴포넌트의 것이든 검토 대기로 들어온다 | 리듀서가 다른 컴포넌트의 연산 이름을 알지 않는다. Blender 렌더(2-7)의 결과도 검토를 거친다(기존 앱은 바로 채택이었다) | 만든 연산이 기록에 표시를 남기고 리듀서가 그것을 본다 |
| 채택·보류는 사용자만 한다(`agent: "none"`) | 기존 앱에 에이전트가 채택하는 도구가 없었다 | `run`으로 바꾼다 |
| 폴더 삭제도 제안이다 | 기존 앱이 그랬다. 에셋은 남지만 정리한 구조가 사라진다 | `run`으로 바꾼다 |
| 삭제는 상태에서만 한다. 파일은 남는다 | 기록은 추가만 하고 실행 취소가 삭제를 되돌린다 | 2-8에서 정리 작업을 더한다 |
| 파일은 dsh의 fetch 라우트(`/api/cs/asset?id=`)로 내려준다 | dsh가 소유자인지 확인해 준다. DreamVerse의 날 라우트(`/dv/assets/<id>`)에는 인증이 없다 | 날 라우트에 `connection.admit` |
| 올리기는 `@cs/asset`의 라우트다. 화면용 API에 두지 않는다 | 화면용 API가 기능 컴포넌트의 연산 이름을 알지 않게 한다 | `@cs/api`가 `csAsset`을 주입받는다 |
| 썸네일은 ffmpeg으로 만든다 | 이미지 라이브러리를 의존성으로 더하지 않는다. ffmpeg은 미디어 검수(2-6)에도 든다 | `sharp`을 더한다 |
| 태그는 프로젝트마다 따로다 | 태그 표가 따로 없고 에셋의 값이다 | — |

## 일의 나눔

| 묶음 | 파일 | 누가 |
| --- | --- | --- |
| 계약: 타입, 패키지 틀, 프로젝트 계층·화면용 API의 추가, 번들 | `packages/asset/src/types.ts`, `package.json`들, `packages/project/**`, `packages/api/**`, `packages/bundle/**` | 지휘 세션 |
| ffmpeg 서비스(옮기기) | `packages/ffmpeg/**` | 서브 에이전트(표준) |
| 저장소, 썸네일, 라우트, 서비스의 조립 | `packages/asset/src/store.ts`, `thumbs.ts`, `routes.ts`, `index.ts`와 시험 | 서브 에이전트(표준) |
| 리듀서, 연산, 목록 | `packages/asset/src/reducer.ts`, `operations.ts`, `library.ts`와 시험 | 서브 에이전트(표준) |
| 조합 시험, 문서, 고지 | `tests/integration/asset.test.ts`, `docs/**`, `THIRD_PARTY_NOTICES.md` | 지휘 세션 |

## 완료 기준

- `pnpm check`와 `pnpm test:integration`이 통과한다.
- 단위 시험: 저장소(같은 바이트는 한 번, 재시작 뒤 다시 읽기, 큰 파일을 조각으로), 리듀서의 규칙 일곱(특히 가져오기와 단계의 순서가 바뀌어도 같은 결과), 연산의 `precondition`마다, 목록의 거르기와 쪽 넘김, 라우트(Range, 종류 가리기, 한도).
- 조합 시험: 로그인한 페이지에서 파일을 올린다 → 상태의 `asset` 조각에 채택된 항목이 뜬다 → 파일을 Range로 받는다 → 태그를 붙이고 실행 취소한다(태그는 사라지고 가져온 에셋은 남는다) → 쿠키 없는 요청은 401이다.

## 결과

2026-11-29에 끝났다.

확인한 것:

- `pnpm check` 통과(단위 시험 882개. 이 갈래의 것은 `packages/asset` 165개, `packages/ffmpeg` 13개).
- `pnpm test:integration` 통과(27개). 새 시험 `tests/integration/asset.test.ts`가 실제 dsh에서 본다: 로그인한 페이지가 PNG를 올린다 → `asset` 조각에 채택된 항목이 뜨고 히스토리의 위치는 그대로다 → 파일을 통째로, Range로(206, 416) 받는다 → 썸네일(ffmpeg이 있으면 WebP, 없으면 404) → HTML은 `application/octet-stream` 첨부로 온다 → 올리기만 한 바이트(stage)는 라이브러리에 없다 → 가짜 LLM이 `cs_asset_tag`를 부르고 사용자가 실행 취소한다(태그는 사라지고 가져온 에셋은 남는다) → `cs_asset_delete`는 제안으로 남고 승인하면 항목이 빠진다(파일은 남는다) → 쿠키 없는 요청은 401이다. 모델이 받는 도구에 `cs_asset_import`·`cs_asset_review`가 없다.
- ffmpeg이 없는 장비에서는 돌려 보지 않았다(**미확인**. 단위 시험은 가짜 ffmpeg으로 그 길을 본다). 실제 모델로도 돌려 보지 않았다(**미확인**).

계획과 달라진 것:

| 달라진 것 | 이유 |
| --- | --- |
| 리듀서 규칙 1: 출력이 `marks`를 지우지 않는다. 지운 표시(`deleted_at`)는 남기고, 그 밖의 표시(검토, 폴더, 태그)는 새 항목으로 옮긴다 | 가져오기(T1) → 삭제(T3) → 같은 바이트의 출력(T4)에서, 나중에 받는 T1의 가져오기가 에셋을 가져온 것으로 되살리면 안 된다 |
| 리듀서 규칙 6: 이미 있는 항목이 가져오기보다 나중의 출력이면 `origin`·`record`·`added_at`을 가져오기의 것으로 바꾼다 | 실제 시각 순서에서는 가져오기가 먼저다 |
| `asset.import`에 파라미터가 없다(`name?`을 뺐다) | 이름은 저장소의 항목에 있다 |
| 라우트 `/api/cs/asset/stage`를 더했다 | 다른 기능 컴포넌트의 연산이 입력으로 받을 파일(워크플로 파일, 2-3c)을 올릴 길 |
| 올리기의 거절은 본문을 끝까지 읽은 뒤에 답한다(한도만큼 더 읽고 그만둔다) | dsh가 본문을 다 읽지 않고 답한 스트리밍 라우트의 연결을 끊어, 브라우저가 답 대신 네트워크 오류를 본다(조합 시험에서 봤다) |
| 연산의 출력(`context.importAsset`)도 배경에서 크기·길이를 읽는다 | 가져오기는 동기라 기다릴 수 없다. 생성의 출력에도 크기가 붙어야 한다 |
| `ComponentStates`를 보강하는 `declare module`은 `@cs/project/types` 하나로 쓴다 | `@cs/project`와 섞으면 한쪽의 보강이 보이지 않는다(`docs/CONVENTIONS.md`) |

구현하며 더 정한 것(Claude가 고른 기본값):

- 태그는 떼기를 먼저, 붙이기를 나중에 한다(둘 다에 든 태그는 붙는다). 폴더 깊이는 `옮길 자리의 깊이 + 폴더의 높이 ≤ 4`다. `asset.folder_update`는 `name`과 `parent`가 둘 다 없으면 거절한다.
- 올리기의 오류 코드: 한도 초과는 413 `payload_too_large`, 만들 수 없는 썸네일은 404 `no_thumbnail`.
- `folder`를 준 올리기에서 이동이 거절되면 오류를 답하지만 가져오기는 이미 끝나 있다.
- 썸네일: ffmpeg이 없는 것은 실패로 기억하지 않는다(생기면 만든다). ffmpeg이 실패한 에셋만 프로세스가 사는 동안 다시 시도하지 않는다.
- 목록의 커서는 `base64url(JSON [added_at, id])`다.

2-3a의 후속을 이 갈래에 넣었다(2-3a를 병합한 뒤의 독립 리뷰가 찾았다):

- **에이전트의 히스토리 이동이 사용자만 정하는 단계를 넘지 못한다.** `cs_proj_undo`·`cs_proj_redo`가 `propose`·`none` 연산의 단계를 되돌리거나 되살리려 하면 `agent_not_allowed`로 거절한다(`packages/project/src/proj-tools.ts`의 `refuseGuardedMove`). 그 전에는 사용자가 실행 취소한 삭제를 에이전트가 다시 실행하거나, 사용자의 검토를 에이전트가 되돌릴 수 있었다. Claude가 고른 기본값이다: 삭제를 되살리는 쪽(실행 취소)도 막는다. 풀려면 그 함수에서 되돌리는 방향을 허용한다.
- 제안의 중복 접기가 `based_on`·`supersedes`까지 같을 때만 접는다(전에는 다른 기록을 가리키는 제안이 먼저 것에 묻혔다).
- 고치지 않은 것: 승인의 실행이 끝난 뒤 결정 기록을 쓰기 전에 프로세스가 죽으면 제안이 대기로 남고, 다시 승인하면 한 번 더 실행된다(2-3a 계획에 적은 것 그대로다). `precondition`이 `ProjectError`가 아닌 오류를 던지면 승인 라우트가 500으로 답한다(연산 실행 라우트와 같다. 연산은 `ProjectError`를 던진다).
