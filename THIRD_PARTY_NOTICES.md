# Third-Party Notices

이 저장소가 다른 저장소에서 가져온 코드와 그 고지를 모은다. 코드를 가져올 때마다 출처(저장소, 커밋), 가져온 범위, 바꾼 것을 적고 라이선스 고지를 남긴다(`AGENTS.md` "꼭 지킬 것"). npm으로 설치해 쓰는 의존성은 여기 적지 않는다(`pnpm licenses list`로 본다).

## DreamVerse Harness

| 항목        | 값                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------- |
| 저장소      | https://github.com/fastvideo-project/dreamverse-harness                                      |
| 커밋        | `ec0ac62760e3b7b2ba058941eaf6a15c3a16a3cf`                                                    |
| 라이선스    | MIT                                                                                          |
| 가져온 것   | `packages/dv/project/`의 `src/`, `tests/`, `CONTRACTS.md`. `packages/dv/api/`의 `src/` 가운데 `index.ts`, `api.ts`, `wire.ts`, `events.ts`, `summaries.ts`, `projects-admin.ts` |
| 이 저장소의 자리 | `packages/project/`(`@cs/project`). 시험은 `src/*.test.ts`와 `src/testing/`으로 옮겼다. `packages/api/`(`@cs/api`) |
| 가져온 때   | 2026-11-27(단계 2-0), 2026-11-28(단계 2-2)                                                   |

`packages/project/`에서 바꾼 것(상세는 `docs/archive/PLAN_2-0.md`):

- 이름: `@dv/project` → `@cs/project`, `dvProject` → `csProject`, 도구 접두사 `dv_` → `cs_`, 기록 디렉터리 `.dreamverse` → `.comfy-studio`, 인용 주소 `dv:` → `cs:`.
- dsh 0.2.2-rc.5에 맞춤: 세션 프로젝션 등록과 읽기, 턴 번호 읽기, 새 프로젝트 폴더의 기본 위치, 시험의 도구 실행 호출.
- 이 저장소의 코드 규칙: 지울 수 있는 TypeScript 문법만(생성자 매개변수 속성을 필드 선언으로 풀었다), Prettier, oxlint.
- 에셋 저장소가 등록되기 전에는 빈 저장소로 대신한다. 연산의 `label`은 문자열 하나다. 기록의 `surface` 값과 에이전트가 읽는 글에서 영상 제작 용어를 걷어냈다.
- 2-2에서 더한 것: 에셋 저장소의 읽기 쪽만 내주는 `assets()`. 입력 역할을 연산의 자기 열쇠에서만 찾는다(원본은 `constructor` 같은 이름을 아는 역할로 본다).
- 동작을 고친 곳 둘: 결정적 연산의 재사용은 입력의 역할과 역할 안의 순서까지 같을 때만 한다(원본은 에셋 목록을 정렬해 비교했다). `<기록>#<출력>`으로 가리킨 입력은 가리킨 기록도 생산자로 본다(원본은 에셋을 마지막으로 낸 기록만 봤다).

`packages/api/`에서 바꾼 것(상세는 `docs/archive/PLAN_2-2.md`):

- 이름: `@dv/api` → `@cs/api`, `dvApi` → `csApi`, 경로 `/api/dv/…` → `/api/cs/…`, `/dv/events` → `/cs/events`.
- 뺀 것: 에셋 가져오기 라우트(`asset-import.ts`), 스킬 묶음 업로드(`user-skills.ts`), 카탈로그 라우트와 스트림의 `models` 이벤트, 타임라인에 기대는 부분(프로젝트 요약의 표지, 상태의 에셋 목록). `projects-admin.ts`의 두 라우트는 `api.ts`에 합쳤다.
- 에셋은 `@dv/asset-pool` 대신 프로젝트 계층에 등록된 에셋 저장소에서 읽는다. 그러려고 `@cs/project`에 `assets()`를 더했다. 에셋 항목의 모양이 `{id, mime, name, url}`로 줄었다.
- 요청의 `surface`는 `chat` 또는 `view`다(원본은 `canvas`, `timeline`, `asset_pool`).
- 동작을 고친 곳: 이벤트 스트림은 Connection이 소유자로 받아들인 요청에만 열리고, Connection이 없으면 등록하지 않는다(원본은 Connection이 없으면 모든 요청에 연다). 플러그인이 내려가면 열린 스트림을 끝내고, 읽지 않는 클라이언트의 버퍼가 4MiB를 넘어도 끝낸다. 프로젝트 만들기는 한 번에 하나씩 처리한다(원본은 동시에 온 요청이 같은 제목을 받는다). 제목과 폴더 이름의 제어 문자와 200바이트 넘는 길이, 없는 폴더, 읽기 전용 연산의 실행은 400으로 거절한다(원본은 500이거나, 연산을 돌린 뒤 거절한다). 입력 역할은 `Map`으로 모은다.
- 시험은 옮기지 않고 새로 썼다. 원본의 시험은 여기에 없는 영상 컴포넌트로 상태를 만든다.
- 이 저장소의 코드 규칙: 지울 수 있는 TypeScript 문법만, Prettier, oxlint.

DreamVerse Harness는 DeepSeek Harness의 포크이고, 가져온 코드의 저작권 표기는 아래 두 줄이다.

```
MIT License

Copyright (c) 2026 FastVideo Team, Hao AI Lab
Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
