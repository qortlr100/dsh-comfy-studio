# 단계 계획 — 1-0 저장소 틀

`docs/ROADMAP.md` 1-0의 상세 계획이다. 브랜치는 `1-0-repo-skeleton`이다(2026-11-25~26).

## 범위

빈 저장소에서 "설치 → 프로필 만들기 → 실행" 세 명령으로 dsh 웹이 우리 번들과 함께 뜨는 상태를 만든다.

- pnpm 워크스페이스, `@deepseek-ai/dsh` 0.2.2-rc.5 고정, `.gitignore`
- 번들 `@cs/bundle`과 호스트 절반만 있는 빈 플러그인 하나
- 프로필을 만들고 띄우는 스크립트
- TypeScript 기본 설정과 `typecheck`, 린터와 포매터

범위 밖: 브라우저 절반과 브라우저 번들 빌드(1-1), Vitest와 조합 시험(1-2).

## 사용자가 정한 것

세 가지는 `docs/DECISIONS.md` "미정"과 로드맵의 "정할 것"이었다. 2026-11-26에 안을 보이고 사용자가 골랐다.

| 무엇                | 고른 답                    | 보인 안                                                                                   |
| ------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| 개발용 `DSH_HOME`   | 공용 하나, 자동 재링크     | 공용 하나 + 자동 재링크(권함) / 워크트리마다 따로 / 저장소 밖 공용 하나                   |
| 린터와 포매터       | oxlint + Prettier          | ESLint + Prettier(권함) / Biome / oxlint + Prettier                                       |
| TypeScript 버전     | 6.0.3                      | 6.0.3(권함) / 5.9.3                                                                       |

안을 만들 때 쓴 사실(2026-11-25~26):

- 번들 링크를 다른 경로로 다시 거는 데 약 0.5초가 걸린다. 프로필의 `bundles` 목록에 번들이 겹쳐 들어가지 않고, 프로필의 `cordis.patch.yml`은 그대로 남는다(**띄워 확인**).
- 업스트림 dsh는 린터로 oxlint를 쓴다(타입 기반 규칙을 켠 `.oxlintrc.json`). 포매터 설정 파일은 저장소 뿌리에 없다(**소스 확인**: 태그 `dsh-v0.2.2-rc.5`).
- TypeScript 5.9.3과 6.0.3 둘 다 `@deepseek-ai/cordis` 4.1.0의 타입을 쓰는 표본 코드를 통과시키고 같은 오류를 잡는다(`skipLibCheck`를 꺼도 같다). npm `latest`는 7.0.2이고 dsh의 peer 허용 범위(`>=5 <7`) 밖이다.

## Claude가 고른 기본값

사용자에게 따로 묻지 않고 정한 것이다. `docs/DECISIONS.md` "전제"에 적었다.

- **빈 플러그인의 이름은 `@cs/ui-shell`**(행 id `cs-ui-shell`, `packages/ui-shell`). 1-1이 이 플러그인에 브라우저 절반을 더하고 3-0이 셸로 만든다. `docs/DSH.md`의 예시와 같은 이름이다.
- **명령 이름**: `pnpm dsh:profile`, `pnpm dsh:start`, `pnpm dsh:config`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm format:check`.
- **스크립트는 TypeScript로 쓰고 Node가 바로 실행한다**(`node scripts/dsh.ts`). 빌드 단계와 실행기 의존성(`tsx`)이 없다. Node 24.9 이상이 dsh의 요구이므로 타입 지우기를 쓸 수 있다. 그래서 `tsconfig.base.json`에 `erasableSyntaxOnly`를 켰다(enum과 생성자 매개변수 속성을 쓰지 않는다).
- **Prettier 설정은 기존 저장소의 것 그대로**다(세미콜론, 큰따옴표, 끝 쉼표, 폭 100). Markdown은 Prettier에서 뺐다. 넣으면 표를 다시 맞추느라 기존 문서 여덟 개가 전부 바뀐다.
- **oxlint 범주는 `correctness`와 `suspicious`를 오류로** 둔다. 플러그인은 기본 셋(`typescript`, `unicorn`, `oxc`)에 `import`, `promise`, `node`를 더했다. `react` 플러그인은 TSX가 생기는 1-1에서 더한다.
- **타입 기반 린트 규칙은 켜지 않았다.** oxlint에서는 `oxlint-tsgolint`가 따로 필요하다. 비동기 코드가 들어오기 전인 1-2에서 켤지 정한다.
- **pnpm은 `packageManager`로 10.34.8에 고정**한다(확인에 쓴 버전).
- **개발 의존성의 버전은 전부 정확한 버전으로 적는다**(`^` 없이).

## 만든 것

| 파일                                             | 내용                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `package.json`, `pnpm-workspace.yaml`            | 루트 워크스페이스(`packages/*`), dsh 고정, 명령                                                        |
| `packages/bundle/`                               | `@cs/bundle`. `cordis.patch.yml`이 `cs-ui-shell` 행 하나를 넣는다                                      |
| `packages/ui-shell/`                             | `@cs/ui-shell`. 호스트 절반 `index.js`만 있다(`apply`가 비어 있다)                                     |
| `scripts/dsh-env.ts`                             | home 위치 계산, 프로필 만들기, 번들 링크 맞추기                                                        |
| `scripts/dsh.ts`                                 | `profile`·`start`·`config` 명령                                                                        |
| `tsconfig.base.json`, `tsconfig.json`            | 공통 옵션, 루트 프로그램(`scripts/`)                                                                   |
| `.oxlintrc.json`, `.prettierrc`, `.prettierignore` | 린트와 포맷 설정                                                                                     |
| `.gitignore`                                     | `node_modules/`, `lib/`, `build/`, `*.tsbuildinfo`, `.dsh-home/`, `.worktree/`                         |

### DSH_HOME과 번들 링크

- home은 **본 체크아웃의 `.dsh-home`** 하나다. 스크립트가 `git rev-parse --git-common-dir`로 본 체크아웃을 찾으므로 어느 워크트리에서 돌려도 같은 home을 쓴다. `.gitignore`에 넣었다.
- `DSH_HOME` 환경 변수를 주면 그 경로를 쓴다. 두 워크트리에서 동시에 띄울 때와 시험용 임시 home에 쓴다.
- `dsh:profile`·`dsh:start`·`dsh:config`는 모두 먼저 프로필을 맞춘다: 프로필이 없으면 `web` 템플릿으로 만들고, 프로필의 번들 링크가 지금 체크아웃의 `packages/bundle`이 아니면 `dsh plugin add`로 다시 건다. 이미 맞으면 아무것도 바꾸지 않는다.
- `--from-default-profile`은 있던 프로필을 덮어쓰므로 프로필이 없을 때만 돌린다.
- 스크립트가 찍는 줄은 전부 stderr로 간다. stdout에는 dsh가 찍는 것만 나가서 `pnpm -s dsh:config > 파일`이 깨끗하다.

## 확인한 것

전부 2026-11-25~26에 Node 24.22.3, pnpm 10.34.8로 **띄워 확인**했다.

- `pnpm install` → `pnpm dsh:profile` → `pnpm dsh:start --no-open --port 0`으로 dsh 웹이 뜬다. 헤드리스 Chromium으로 연 페이지에 사이드바와 Preview Notice 창이 그려지고 콘솔 오류·경고가 0건이다.
- `pnpm -s dsh:config` 출력(1,290줄, 203행)의 마지막에 `# == @cs/bundle` 계층과 `cs-ui-shell` 행이 있다.
- 호스트 절반만 있는 플러그인의 `apply(ctx)`가 기동 때 불린다(시험 삼아 넣은 출력으로 확인하고 뺐다).
- `dsh:profile`을 두 번 돌리면 둘째는 아무것도 바꾸지 않는다(`kept`, `unchanged`).
- 기본 경로(환경 변수 없이)로 워크트리에서 돌리면 본 체크아웃의 `.dsh-home`에 프로필이 생긴다.
- `dsh:start`에 SIGTERM을 보내면 dsh가 같이 끝나고 프로세스가 남지 않는다.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`가 통과한다. 일부러 넣은 오류를 `typecheck`와 `lint`가 잡는다.

## 하다가 알게 된 것

`docs/DSH.md`에 옮겨 적었다.

- 패치가 빈 배열(`[]`)인 번들도 기동한다. 그때 `--dump-config`에는 그 번들의 머리 줄이 나오지 않는다.
- 링크된 패키지의 호스트 절반을 `.ts`로 두어도 Node 24.22.3이 바로 읽는다. 1-0의 플러그인은 로드맵대로 `index.js`로 두었고, 호스트 절반을 무엇으로 쓸지는 1-1에서 정한다.
- 프로필을 만드는 것만으로는 프로필에 `node_modules`가 생기지 않는다. `dsh plugin add`를 처음 돌릴 때 생긴다.
- pnpm 10은 의존성의 설치 스크립트를 돌리지 않는다(`node-pty`, `koffi` 등 다섯 개). 그 상태로 웹은 뜬다. 에이전트의 셸 도구에 영향이 있는지는 보지 않았다.
- 첫 실행의 Preview Notice 창은 페이지 로드가 끝난(`networkidle`) 뒤에 뜬다.

## 계획과 달라진 점

- 로드맵의 "프로필을 만들고 띄우는 스크립트"에 합성 구성을 찍는 `dsh:config`를 더했다. 완료 기준이 그 출력을 본다.
- 로드맵의 `.gitignore` 목록 그대로다. 더하거나 뺀 것이 없다.

## 후속

- 타입 기반 린트 규칙을 켤지(1-2).
- 무시된 설치 스크립트가 에이전트의 셸 도구에 영향을 주는지(1-3, 1-4).
- 호스트 절반을 TypeScript로 쓸지와 그때의 타입 검사 구성(1-1).
- `README.md`와 CI는 여전히 사용자가 정할 일이다(`docs/DECISIONS.md` "미정").
