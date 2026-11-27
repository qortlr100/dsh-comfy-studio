# 단계 계획 — 1-2 시험 틀

`docs/ROADMAP.md` 1-2의 상세 계획이다. 브랜치는 `1-2-test-harness`다(2026-11-27).

## 범위

고치고 확인하는 고리에 시험을 넣는다.

- Vitest로 도는 단위 시험과 `pnpm test`
- dsh를 실제로 띄우는 조합 시험과 `pnpm test:integration`: 브라우저로 화면을 보는 것, 호스트 쪽 서비스를 부르는 것
- 조합 시험이 쓰는 틀(`tests/harness/`)
- 타입 기반 린트 규칙을 켤지(로드맵의 "정할 것". 아래 "사용자가 정한 것")

범위 밖: 실제 모델이 있어야 하는 시험(1-3), 브라우저 절반의 React 컴포넌트를 DOM 흉내 환경(jsdom 등)에서 도는 단위 시험(필요해지면 더한다. 지금은 조합 시험이 실제 브라우저로 본다), CI(`docs/DECISIONS.md` "미정").

## 사용자가 정한 것

`docs/DECISIONS.md` "미정"이자 로드맵 1-2의 "정할 것"이었다. 2026-11-27에 안을 보이고 사용자가 골랐다.

| 무엇 | 고른 답 | 보인 안 |
| --- | --- | --- |
| 타입 기반 린트 규칙을 켤지 | 켠다 | 켠다(권함) / 켜지 않는다 / 켜되 타입 단언 규칙은 끈다 |

안을 만들 때 쓴 사실(2026-11-27, 이 저장소에서 돌려 봤다):

- `oxlint-tsgolint` 7.0.2009가 oxlint 1.95.0과 지금의 `tsconfig`(TypeScript 6.0.3)로 돈다. `pnpm lint`가 0.25초에서 0.38초가 됐다.
- 지금 범주(`correctness`, `suspicious`) 그대로 켜면 기다리지 않은 Promise(`no-floating-promises`), Promise가 아닌 값의 `await`(`await-thenable`), 객체를 문자열로 만드는 것(`no-base-to-string`, `restrict-template-expressions`), 좁히는 타입 단언(`no-unsafe-type-assertion`)을 잡는다(표본 코드로 봤다).
- `no-misused-promises`(`forEach`에 async 콜백 등)는 범주에 없어 따로 켜야 한다.
- 기존 코드에서는 `scripts/build-client.ts`의 타입 단언 4건이 걸렸다.
- 업스트림 dsh는 켜고 쓴다(`oxlint-tsgolint` 7.0.2001, **소스 확인**).

한 것:

- `.oxlintrc.json`에 `options.typeAware: true`와 `typescript/no-misused-promises: error`를 넣었다. `oxlint-tsgolint`는 루트 devDependency다.
- `scripts/build-client.ts`의 4건은 단언을 타입 가드(`isRecord`)와 구조 분해로 바꿨다. 동작은 같다(단위 시험 19개가 그대로 통과한다).
- 규칙을 끈 곳은 둘이고 둘 다 이유를 주석으로 적었다: `tests/harness/host.ts`의 `parsed.value as T`(부르는 쪽이 결과 타입을 정하는 API다), `tests/harness/browser.ts`의 `preserve-caught-error`(원래 오류에 토큰이 든 주소가 있어 `cause`로 달지 않는다).
- 설정으로 켠 뒤 표본 코드로 다시 봤다: 기다리지 않은 Promise와 `forEach`의 async 콜백이 오류가 된다.

## 고른 것

로드맵 1-2가 "방법을 여기서 정한다"고 한 것과 그에 딸린 기본값이다. Claude가 골랐고 사용자에게 따로 묻지 않았다(`docs/DECISIONS.md` "전제"). 호스트 쪽 방법은 로드맵이 후보로 적어 둔 것을 띄워 확인하고 그대로 골랐다.

| 무엇 | 고른 것 | 이유 | 뒤집으면 |
| --- | --- | --- | --- |
| 호스트 쪽 조합 시험의 방법 | **시험용 호스트 플러그인(프로브)을 `--patch`로 얹고, 시험이 준 시나리오 모듈을 dsh 프로세스 안에서 실행해 결과를 파일로 돌려받는다**(아래 "호스트 시나리오") | 화면용 API가 없어도 된다. dsh의 실제 조합(프로필 → 번들 → 로더) 안에서 실제 서비스를 부른다. 프로브는 패치의 행 이름에 절대 경로로 적으면 실리므로 프로필에 설치하지 않는다 | 화면용 API(2-2)가 생기면 HTTP로 부르는 시험을 더한다. 프로브 방식은 API가 없는 서비스에 계속 쓴다 |
| 시나리오를 언제 실행하나 | dsh가 주소 줄(`dsh web: …`)을 찍은 뒤. 틀이 "시작" 파일을 만들고 프로브가 그것을 보고 시작한다 | 주소 줄은 로더가 다 실린 뒤에 나온다. 프로브의 `apply` 때는 다른 플러그인이 아직 실리는 중이다(그때 `ctx.tools`의 도구는 0개였고 0.1초 뒤 5개였다) | 프로브가 `apply`에서 바로 실행하게 한다 |
| 시험의 home | **띄울 때마다 새 임시 home**(`DSH_HOME`과 `HOME` 둘 다 임시 폴더). 끝나면 지운다 | 프로필을 만드는 데 0.7초다. 시험끼리 상태가 섞이지 않고 병렬로 돌 수 있다. 개발용 home의 키와 설정, 사용자의 실제 홈 폴더를 건드리지 않는다 | 한 home을 만들어 두고 같이 쓴다(직렬로 돌려야 한다) |
| dsh에 넘기는 환경 변수 | 허용 목록만 넘긴다(`PATH`, `HOME`(임시), 로케일, `TMPDIR`, `DSH_HOME`) | 개발자의 셸에 있는 모델 키가 시험에 섞이지 않는다(dsh는 `DEEPSEEK_API_KEY` 등을 읽는다). 시험은 키 없이 돈다 | `launchDsh`의 `env`로 더 넘긴다 |
| 첫 실행 창 | 실제 사용자처럼 버튼으로 닫는다(`Continue`, `Close`) | 띄워 확인한 방법이다. 설정으로 끄는 길(`ui-settings-general`의 `welcomeNoticeVersion`, `ui-settings-models`의 `credentialOnboarding`)은 소스로만 봤다 | 패치로 끈다 |
| 명령 | `pnpm test`(단위), `pnpm test:integration`(조합), `pnpm check`(빌드·타입·린트·포맷·단위 시험을 한 번에) | 단위 시험은 커밋 전마다 돌릴 만큼 빠르다. 조합 시험은 dsh와 브라우저를 띄우므로 따로 둔다 | `package.json`의 `scripts`만 바꾼다 |
| 시험 파일의 자리 | 단위 시험은 대상 옆(`x.ts` 옆에 `x.test.ts`). 조합 시험과 틀은 루트의 `tests/` | 조합 시험은 프로필 전체를 띄우므로 어느 한 패키지의 것이 아니다 | Vitest 설정의 `include`를 바꾼다 |
| 브라우저 | `playwright-core` 1.65.1과 그 판이 받는 헤드리스 Chromium(`pnpm exec playwright-core install chromium-headless-shell`). `CHROME`에 실행 파일 경로를 주면 그것을 쓴다 | `playwright-core`는 브라우저를 싣지 않아 설치가 가볍다. 지금까지의 확인에 쓴 도구다 | `playwright`로 바꾼다 |
| Vitest 버전 | 5.1.2 | 기존 앱의 시험이 5.x다(4-0에서 옮긴다) | — |

## 틀의 명세 — `tests/harness/`

Node가 TypeScript를 바로 실행하는 코드와 같은 규칙으로 쓴다(지울 수 있는 문법만, 상대 import에 `.ts`). 프로브와 시나리오는 Vitest가 아니라 dsh 프로세스의 Node가 읽으므로 이 규칙이 필수다.

**로그인 주소를 남기지 않는다.** dsh가 찍는 주소에는 토큰이 들어 있다. 틀이 밖으로 내보내는 모든 글(오류 메시지, `output()`, 브라우저 콘솔 기록)은 `redactLoginUrls`를 거친다. 주소 자체는 `DshInstance.url`로만 건넨다.

### `dsh.ts` — 띄우고 내리기

```ts
export interface TestHome {
  readonly dshHome: string;   // DSH_HOME. 프로필 comfy-studio가 지금 체크아웃의 번들에 링크돼 있다
  readonly userHome: string;  // dsh 프로세스의 HOME
  remove(): void;             // 둘을 담은 임시 폴더를 지운다. 여러 번 불러도 된다
}
export function createTestHome(): TestHome;

export interface LaunchOptions {
  home?: TestHome;               // 없으면 새로 만들고 stop() 때 지운다. 주면 지우지 않는다(같은 home으로 다시 띄우는 시험)
  patches?: readonly string[];   // --patch 파일들. 준 순서대로
  args?: readonly string[];      // 웹 앱 인자. `--no-open --port 0` 뒤에 붙는다
  env?: Readonly<Record<string, string>>;  // 허용 목록 위에 더할 환경 변수
  startupTimeoutMs?: number;     // 기본 30_000
  allowInactiveEntries?: boolean; // 기본 false
}
export interface DshInstance {
  readonly url: string;          // 토큰이 든 로그인 주소. 찍지 않는다
  readonly home: TestHome;
  output(): string;              // 지금까지의 stdout+stderr. 주소는 가려져 있다
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;         // 여러 번 불러도 된다
}
export function launchDsh(options?: LaunchOptions): Promise<DshInstance>;
export function redactLoginUrls(text: string): string;   // http(s) 주소를 통째로 `<url>`로, 주소 밖의 `token=값`을 `token=<redacted>`로 바꾼다
```

- `createTestHome`: `mkdtempSync(join(tmpdir(), "cs-dsh-test-"))` 아래에 `dsh-home/`과 `user-home/`을 만들고 `scripts/dsh-env.ts`의 `ensureProfile(dshHome)`을 부른다.
- 실행 명령: `scripts/dsh-env.ts`의 `dshCommand([...])`. 인자 순서는 `--profile comfy-studio`, `--patch <p>`…, `--no-open`, `--port 0`, `args`…다. **`--patch`는 런처의 옵션이라 웹 앱 인자보다 앞에 와야 한다**(뒤에 두면 `unknown option '--patch'`로 끝난다).
- 환경 변수: `process.env`에서 `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TZ`만 옮기고 `HOME=userHome`, `DSH_HOME=dshHome`을 넣은 뒤 `options.env`를 덮는다.
- 준비 판정: stdout과 stderr를 한 버퍼에 모으고 `/dsh web: (https?:\/\/\S+)\s/`가 맞으면 준비된 것이다(출력은 조각으로 오므로 주소 뒤의 줄바꿈까지 본다). 그 뒤 50ms를 더 기다려 stderr를 받는다.
- 준비 뒤 버퍼에 `did not activate`가 있으면(행 하나가 `apply`에서 던지면 dsh는 `dsh: warning: 1 entry did not activate`를 찍고 계속 뜬다) `allowInactiveEntries`가 아닌 한 내리고 오류를 던진다.
- 준비 전에 프로세스가 끝나면(예: 브라우저 번들이 없으면 `startup failed`로 종료 코드 1) 종료 코드와 가린 출력을 담아 던진다. `startupTimeoutMs`를 넘겨도 내리고 같은 식으로 던진다.
- `exited`는 프로세스의 `close`(출력 파이프까지 닫힌 뒤)에 풀린다. 그래야 마지막 출력까지 `output()`에 들어온다.
- `stop()`: SIGTERM을 보내고 끝나기를 기다린다(dsh는 정리하고 약 0.8초 뒤 종료 코드 0으로 끝난다. dsh 쪽 정리 한도는 5초다). 8초 안에 안 끝나면 SIGKILL. 그 뒤 틀이 만든 home이면 지운다. 실패한 `launchDsh`도 같은 정리를 한다.
- 마지막 방어: 살아 있는 자식과 지우지 않은 임시 home을 모듈 수준의 집합에 두고 `process.once("exit")`에서 SIGKILL을 보내고 지운다(Vitest가 중간에 끊겼을 때).

### `host.ts`와 `probe/index.ts` — 호스트 시나리오

```ts
// 시나리오 모듈(dsh 프로세스 안에서 실행된다)
export const inject = ["tools"];                       // 기다릴 서비스. 없어도 된다
export default async function (ctx: Context, input: unknown): Promise<unknown> { … }  // 돌려준 값은 JSON으로 건너간다

// host.ts
export interface HostScenarioOptions {
  input?: unknown;               // JSON으로 건너간다
  home?: TestHome;
  patches?: readonly string[];   // 프로브 패치보다 앞에 놓인다
  timeoutMs?: number;            // 주소 줄 뒤 보고를 기다리는 한도. 기본 30_000
}
export function runHostScenario<T = unknown>(scenario: string | URL, options?: HostScenarioOptions): Promise<T>;
```

- `scenario`는 파일 주소(`new URL("./scenarios/x.ts", import.meta.url)`)나 절대 경로다.
- `runHostScenario`: 임시 폴더에 패치 파일을 쓴다. 내용은 JSON 한 줄이다(JSON은 YAML이기도 하고 dsh가 그대로 읽는다. YAML 라이브러리가 필요 없다).
  `[{"insert":[{"id":"cs-test-probe","name":"<probe/index.ts의 절대 경로>","config":{"scenario":"<file URL>","report":"<경로>","go":"<경로>","input":…}}]}]`
  그 패치로 `launchDsh` → 준비되면 `go` 파일을 만든다 → `report` 파일이 생기거나, 프로세스가 끝나거나, `timeoutMs`가 지날 때까지 기다린다(25ms 간격) → `stop()` → 임시 폴더를 지운다.
- 보고가 `{ ok: true, value }`면 `value`를 돌려준다. `{ ok: false, error: { name, message, stack } }`면 그 이름·메시지·스택과 가린 dsh 출력을 담은 `Error`를 던진다. 보고 없이 끝났거나 시간이 지났으면 그 사실과 가린 출력을 담아 던진다.
- 프로브(`probe/index.ts`, 행 id `cs-test-probe`): `apply(ctx, config)`가 `ctx.effect`로 25ms 타이머를 걸어 `go` 파일을 기다린다(정리 함수에서 타이머를 지운다). 파일이 보이면 `await import(config.scenario)` → `inject`가 있으면 `ctx.inject(inject, (inner) => …)`, 없으면 바로 → `default(ctx, config.input)`의 결과를 `report`에 쓴다(`report + ".tmp"`에 쓰고 `rename`). import 실패, 던짐, 거절, JSON으로 못 바꾸는 값은 모두 `ok: false` 보고가 된다. 서비스를 기다리기 시작할 때 `console.error("cs-test-probe: waiting for services …")`를 찍어, 없는 서비스 때문에 시간이 지났을 때 dsh 출력에서 보이게 한다.
- 프로브와 시나리오는 `import type` 말고는 `node:` 내장 모듈만 값으로 가져온다(시나리오는 자기 패키지의 것을 가져와도 된다. 루트 `node_modules`에서 풀린다).

### `browser.ts` — 화면

```ts
export interface PageSession {
  readonly page: Page;                 // playwright-core
  readonly issues: readonly string[];  // 콘솔의 error·warning과 잡히지 않은 페이지 오류. 주소는 가려져 있다
  close(): Promise<void>;              // 브라우저까지 닫는다
}
export interface OpenPageOptions {
  dismissFirstRun?: boolean;           // 기본 true. 새 home의 두 창(Preview Notice → Get started)을 버튼으로 닫는다
  colorScheme?: "light" | "dark";      // 기본 "light"
}
export function openPage(url: string, options?: OpenPageOptions): Promise<PageSession>;
```

- `chromium.launch({ executablePath: process.env.CHROME || undefined })`. 열 때마다 브라우저 하나를 새로 띄운다. 실행 파일이 없어서 실패하면 `pnpm exec playwright-core install chromium-headless-shell`을 돌리거나 `CHROME`을 주라는 문구로 다시 던진다.
- 화면 크기 1400×900. `page.goto(url, { waitUntil: "networkidle" })`.
- 페이지를 여는 중의 오류는 가린 글만 담은 새 `Error`로 던진다. Playwright의 `goto` 오류에는 토큰이 든 주소가 들어 있고 Vitest는 `cause`를 통째로 찍으므로 원래 오류를 `cause`로 달지 않는다.
- 첫 실행 창: Preview Notice는 로드가 끝난 뒤에 뜨므로 `count()`로 보지 않고 **보일 때까지 기다린 뒤**(`waitFor({ state: "visible" })`) `Continue`를 누른다. 이어서 Get started 창을 같은 식으로 기다려 `Close`를 누른다. 창의 DOM을 지우지 않는다(`docs/DSH.md` "함정").

### `global-setup.ts`

조합 시험 전체에 앞서 한 번 `buildClientBundles(checkoutRoot)`를 돈다(dsh는 `lib/client.js`가 없으면 뜨지 않는다).

## 시험

| 파일 | 종류 | 보는 것 |
| --- | --- | --- |
| `tests/integration/boot.test.ts` | 조합(브라우저) | dsh가 우리 번들과 뜨고 모든 행이 활성화된다. `sidebar.footer.action` 슬롯에 `@cs/ui-shell`의 시험용 요소가 그려진다. `<style data-plugin="@cs/ui-shell">`이 있다. 버튼으로 라이트 → 다크가 바뀐다. 콘솔 오류·경고 0건 |
| `tests/integration/host-scenario.test.ts` | 조합(호스트) | 시나리오가 `ctx.tools.definitions()`를 불러 도구 이름을 돌려주고 입력이 그대로 건너간다. 던지는 시나리오는 그 메시지로 거절된다. 없는 서비스를 기다리는 시나리오는 시간 초과로 거절되고 메시지에 기다리던 서비스 이름이 있다 |
| `tests/harness/redact.test.ts` | 단위 | `redactLoginUrls`가 토큰 주소를 가린다 |
| `scripts/build-client.test.ts` | 단위 | 1-1의 빌드 명세(`docs/archive/PLAN_1-1.md` "빌드 스크립트 명세"): 로더 형식, 공유 모듈 external, 거절하는 import 셋, CSS Modules(클래스 무늬, 주입 코드, `composes`), 매니페스트 검증 다섯, 대상 없는 뿌리 |

## 분담

`AGENTS.md` "구현 작업 분담"을 따른다. 쓰는 파일이 겹치지 않는다.

| 묶음 | 등급 | 파일 |
| --- | --- | --- |
| 틀과 조합 시험 | 상위(프로세스 수명) | `tests/harness/**`, `tests/integration/**` |
| 빌드 스크립트의 단위 시험 | 표준 | `scripts/build-client.test.ts` |
| 설정, 의존성, 문서, 통합, 확인 | 지휘 세션 | `package.json`, `vitest.config.ts`, `tsconfig.json`, `.oxlintrc.json`, `docs/`, `AGENTS.md` |

`scripts/build-client.test.ts`는 표준 등급 서브 에이전트가, `tests/` 아래는 상위 등급 서브 에이전트가 위 명세로 만들었다. 지휘 세션은 코드를 읽고 한 곳을 고쳐 받았다(준비 판정의 정규식이 조각난 주소에 맞을 수 있었다).

## 만든 것

| 파일 | 내용 |
| --- | --- |
| `vitest.config.ts` | 프로젝트 둘: `unit`(패키지의 `src/**/*.test.ts(x)`, `scripts/**/*.test.ts`, `tests/harness/**/*.test.ts`)과 `integration`(`tests/integration/**/*.test.ts`, 시험 한도 60초, `global-setup.ts`) |
| `package.json` | `test`, `test:integration`, `check`. devDependency: `vitest` 5.1.2, `playwright-core` 1.65.1, `oxlint-tsgolint` 7.0.2009, 타입용 `@deepseek-ai/cordis` 4.1.0·`@deepseek-ai/dsh-tools` 0.2.2-rc.5 |
| `.oxlintrc.json`, `scripts/build-client.ts` | 타입 기반 규칙을 켜고 걸린 단언 4건을 고쳤다 |
| `tsconfig.json` | 루트 프로그램이 `tests/`와 `vitest.config.ts`도 검사한다 |
| `tests/harness/dsh.ts` | `createTestHome`, `launchDsh`, `redactLoginUrls` |
| `tests/harness/host.ts`, `tests/harness/probe/index.ts` | `runHostScenario`와 프로브 플러그인 |
| `tests/harness/browser.ts` | `openPage` |
| `tests/harness/global-setup.ts` | 조합 시험 전에 브라우저 번들을 빌드한다 |
| `tests/harness/redact.test.ts` | 단위 시험 4개 |
| `tests/integration/boot.test.ts` | 조합 시험 1개(브라우저) |
| `tests/integration/host-scenario.test.ts`, `tests/integration/scenarios/*.ts` | 조합 시험 3개(호스트)와 시나리오 모듈 셋 |
| `scripts/build-client.test.ts` | 단위 시험 19개 |

## 확인한 것

전부 2026-11-27에 Node 24.22.3, pnpm 10.34.8, 헤드리스 Chromium 159(`playwright-core` 1.65.1이 받은 `chromium-headless-shell` 1255)로 했다.

- [x] **명령 하나로 "dsh 기동 → 우리 플러그인 로드 → 콘솔 오류 0"**: `pnpm test:integration`. 시험 4개가 약 7.3초에 통과한다(세 번 연달아 같았다). 끝난 뒤 dsh·브라우저 프로세스와 임시 폴더가 남지 않는다.
- [x] **시험용 호스트 플러그인이 dsh의 서비스를 불러 결과를 돌려준다**: 시나리오가 `ctx.tools.definitions()`로 얻은 도구 이름(`working_directory` 포함)과, 건네준 입력(한글과 중첩된 JSON)이 그대로 돌아온다.
- [x] **시험이 고장을 잡는다**(하나씩 깨뜨려 보고 되돌렸다):
  - 브라우저 절반의 `apply`에 `console.error`를 넣으면 `boot.test.ts`가 그 문구를 보이며 실패한다.
  - 호스트 절반의 `apply`가 던지면 `launchDsh`가 "a plugin entry did not activate"와 dsh의 출력(행 이름과 스택)으로 거절한다.
  - `lib/client.js`가 없으면 `launchDsh`가 1.6초 뒤 "dsh exited before it was ready (code 1)"과 dsh의 출력으로 거절한다.
  - 시험이 없는 속성을 찾게 하면 위치 지정자를 보이며 실패한다(서브 에이전트가 했다).
  - 던지는 시나리오와 없는 서비스를 기다리는 시나리오는 조합 시험에 들어 있다.
  - 위 실패들의 메시지에 토큰과 주소가 없다.
- [x] **단위 시험이 고장을 잡는다**: `scripts/build-client.ts`를 넷으로 깨뜨려 봤다(클래스 무늬, 공유 모듈 하나 빼기, `dsh.client.external` 검사 빼기, lightningcss `filename`을 절대 경로로). 넷 다 해당 시험이 실패했다. 서브 에이전트가 했고 지휘 세션은 다시 하지 않았다.
- [x] `pnpm check`(빌드, 타입 검사, 린트, 포맷, 단위 시험 23개)가 통과한다.

확인하지 못한 것:

- 8초 뒤의 SIGKILL과 `exit` 훅(dsh가 SIGTERM에 늘 깨끗이 끝났다).
- Chromium이 없을 때의 안내 문구(이 장비에는 있다).
- macOS와 Windows(환경 변수 허용 목록과 신호 처리가 Linux 기준이다).
- 같은 home으로 다시 띄우는 것(`LaunchOptions.home`). 코드는 있고 쓰는 시험은 아직 없다.
- `scripts/build-client.ts`의 React 방어(metafile), `exports["./client"]`의 조건 객체 꼴, CSS 변환 오류의 길.

## 하다가 알게 된 것

`docs/DSH.md`에 옮겨 적었다.

- 런처의 옵션(`--patch`, `--dump-config`)은 웹 앱 인자(`--no-open`, `--port`)보다 **앞에** 와야 한다. 뒤에 두면 `error: unknown option '--patch'`다.
- 패치의 행 `name`에 `.ts` 파일의 절대 경로를 적으면 그 파일이 플러그인으로 실린다(프로필에 설치하지 않아도 된다). 패치 파일의 내용은 JSON이어도 된다.
- 행의 `apply`가 던지면 dsh는 `dsh: warning: 1 entry did not activate`와 스택을 찍고 **계속 뜬다**. 필수 플러그인이 못 뜨면(브라우저 번들이 없을 때의 `modules`) `dsh: startup failed`로 종료 코드 1이다.
- 주입하지 않은 서비스를 `ctx`에서 읽으면 던진다(`cannot get property "x" without inject`). `ctx.inject([이름], 콜백)`은 없는 서비스에 대해 오류 없이 영영 기다린다.
- 기동은 주소 줄까지 약 1.2초, SIGTERM 뒤 종료까지 약 0.8초(종료 코드 0), SIGINT는 종료 코드 130이다. 자식 프로세스는 없었다.
- 프로브의 `apply` 때 `ctx.tools.definitions()`는 0개였고 기동이 끝난 뒤에는 5개였다(`working_directory`, `team_task_*` 넷). 에이전트의 도구 대부분은 이 전역 목록에 없다.
- Preview Notice 창은 `networkidle` 약 24ms 뒤에 보였다.
- `HOME`까지 임시 폴더로 줘도 "Unable to create default workspace" 토스트는 그대로 뜬다(콘솔 오류는 아니다).
- `playwright-core` 1.65.1이 찾는 Chromium은 1255판이다. `playwright-core install`은 받으면서, 지금 있는 어떤 Playwright 설치도 쓰지 않는 판을 캐시에서 지운다(이 장비에서는 그동안 경로로 지정해 쓰던 `chromium-1243`이 지워졌다).

## 계획과 달라진 점

- `redactLoginUrls`가 주소 밖의 `token=값`도 가린다.
- `exit` 훅이 지우지 않은 임시 home도 지운다.
- `runHostScenario`의 임시 폴더 이름은 `cs-dsh-test-scenario-*`다.
- `pnpm check`를 더했다(로드맵에 없던 것).

## 후속

- 화면용 API가 생기면(2-2) 같은 틀로 HTTP를 부르는 시험을 더한다. 2-0의 완료 기준(프로젝트 만들기 → 연산 → 기록 → 실행 취소)은 `runHostScenario`로 쓴다.
- 첫 실행 창을 패치로 끄는 길은 소스로만 봤다. 시험이 늘어 창 닫기가 부담이 되면 띄워 확인하고 `openPage`의 기본값을 바꾼다.
- 브라우저 절반의 React 컴포넌트를 DOM 흉내 환경에서 도는 단위 시험은 필요해지면 더한다.
- CI는 정해지지 않았다(`docs/DECISIONS.md` "미정"). 정해지면 `pnpm check`와 `pnpm test:integration`이 그 내용이다.
