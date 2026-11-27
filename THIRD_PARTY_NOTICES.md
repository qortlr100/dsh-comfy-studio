# Third-Party Notices

이 저장소가 다른 저장소에서 가져온 코드와 그 고지를 모은다. 코드를 가져올 때마다 출처(저장소, 커밋), 가져온 범위, 바꾼 것을 적고 라이선스 고지를 남긴다(`AGENTS.md` "꼭 지킬 것"). npm으로 설치해 쓰는 의존성은 여기 적지 않는다(`pnpm licenses list`로 본다).

## DreamVerse Harness

| 항목        | 값                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------- |
| 저장소      | https://github.com/fastvideo-project/dreamverse-harness                                      |
| 커밋        | `ec0ac62760e3b7b2ba058941eaf6a15c3a16a3cf`                                                    |
| 라이선스    | MIT                                                                                          |
| 가져온 것   | `packages/dv/project/`의 `src/`, `tests/`, `CONTRACTS.md`                                    |
| 이 저장소의 자리 | `packages/project/`(`@cs/project`). 시험은 `src/*.test.ts`와 `src/testing/`으로 옮겼다 |
| 가져온 때   | 2026-11-27(단계 2-0)                                                                         |

바꾼 것(상세는 `docs/archive/PLAN_2-0.md`):

- 이름: `@dv/project` → `@cs/project`, `dvProject` → `csProject`, 도구 접두사 `dv_` → `cs_`, 기록 디렉터리 `.dreamverse` → `.comfy-studio`, 인용 주소 `dv:` → `cs:`.
- dsh 0.2.2-rc.5에 맞춤: 세션 프로젝션 등록과 읽기, 턴 번호 읽기, 새 프로젝트 폴더의 기본 위치, 시험의 도구 실행 호출.
- 이 저장소의 코드 규칙: 지울 수 있는 TypeScript 문법만(생성자 매개변수 속성을 필드 선언으로 풀었다), Prettier, oxlint.
- 에셋 저장소가 등록되기 전에는 빈 저장소로 대신한다. 연산의 `label`은 문자열 하나다. 기록의 `surface` 값과 에이전트가 읽는 글에서 영상 제작 용어를 걷어냈다.
- 동작을 고친 곳 둘: 결정적 연산의 재사용은 입력의 역할과 역할 안의 순서까지 같을 때만 한다(원본은 에셋 목록을 정렬해 비교했다). `<기록>#<출력>`으로 가리킨 입력은 가리킨 기록도 생산자로 본다(원본은 에셋을 마지막으로 낸 기록만 봤다).

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
