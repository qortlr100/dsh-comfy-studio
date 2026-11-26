# 단계 계획 — 1-1 브라우저 절반과 브라우저 번들 빌드

`docs/ROADMAP.md` 1-1의 상세 계획이다. 브랜치는 `1-1-client-build`다(2026-11-26).

## 범위

1-0의 빈 플러그인 `@cs/ui-shell`에 브라우저 절반을 더하고, 브라우저 번들을 만드는 빌드를 갖춘다.

- 브라우저 번들 빌드 스크립트(`pnpm build`)
- 브라우저 쪽 타입 패키지와 타입 검사 구성
- CSS를 싣는 방식
- 규칙대로 쓴 슬롯 등록(`inject`, `hooks`)을 띄워 확인하는 시험용 React 컴포넌트 하나

범위 밖: Vitest와 조합 시험(1-2), 채팅을 우측 탭으로 옮기는 시험 코드(1-3), 셸(3-0). 시험용 React 컴포넌트는 3-0에서 셸로 바뀐다.

## Claude가 고른 기본값

로드맵 1-1의 "정할 것" 셋과 CSS 방식이다. 사용자가 "로드맵 확인하여 다음 작업 진행"이라고만 했고, 따로 묻지 않고 정했다. **사용자가 확인한 것이 아니다.** `docs/DECISIONS.md` "전제"에 적었다. 바꾸려면 "뒤집으면"을 본다.

| 무엇 | 고른 것 | 이유 | 뒤집으면 |
| --- | --- | --- | --- |
| 호스트 절반의 형식 | **`.ts` 그대로 내보낸다**(`main`·`exports["."]`가 `src/index.ts`). 빌드하지 않는다 | 패키지는 프로필에 링크로 들어가고 실제 경로가 `node_modules` 밖이라 Node 24의 타입 지우기가 적용된다. 빌드 단계가 없으면 "고치고 빌드를 잊는" 함정이 호스트 쪽에는 없다. 스크립트(1-0)와 같은 방식이다 | 호스트 절반에도 빌드를 더하고 `exports`를 `lib/index.js`로 돌린다. 패키지를 타르볼로 배포하게 되면 필요하다(`node_modules` 안의 `.ts`는 Node가 읽지 않는다) |
| 타입 검사 구성 | 브라우저 절반이 있는 패키지는 **프로그램 둘**: `tsconfig.json`(호스트: `src/` 중 `src/client/` 밖, Node 타입)과 `tsconfig.client.json`(브라우저: `src/client/`, DOM, JSX). 루트 `pnpm typecheck`가 루트 프로그램과 패키지별 `typecheck`를 차례로 돌린다 | 호스트 코드가 DOM을, 브라우저 코드가 Node API를 쓰면 타입 검사에서 걸린다. 업스트림도 두 쪽을 따로 검사한다 | 패키지에 `tsconfig` 하나만 둔다 |
| oxlint의 `react` 플러그인 | 켠다. 규칙 넷을 따로 맞췄다(아래 "린트 규칙") | 훅 호출 순서와 `key` 누락을 잡는다 | `.oxlintrc.json`에서 뺀다 |
| CSS를 싣는 방식 | **CSS Modules**(`*.module.css`). 빌드가 lightningcss로 클래스 이름을 바꾸고, 팩토리가 실행될 때 `<style data-plugin="<패키지>">`로 넣는다. 그 밖의 `.css` import는 빌드에서 거절한다 | 업스트림 빌드 프리셋과 같은 방식이라 dsh 로더가 플러그인이 내려갈 때 그 `<style>`을 지운다. DreamVerse 화면 패키지가 `.module.css`를 쓰므로(12개) 계획 3에서 옮길 때 그대로 받는다. 패키지가 늘어도 클래스 이름이 겹치지 않는다 | 문자열 CSS를 `ctx.effect`에서 `<style>`로 넣는 방식(2026-11-24에 확인한 것)으로 돌아간다 |
| 번들러 | esbuild 0.28.2(브라우저 번들), lightningcss 1.33.0(CSS Modules). 둘 다 루트 devDependency | esbuild는 2026-11-24에 같은 형식을 만들어 띄워 확인한 도구다. 업스트림 프리셋(tsdown)은 npm에 없다. lightningcss는 업스트림 프리셋이 같은 일에 쓴다 | tsdown으로 프리셋을 다시 쓴다 |
| 클래스 이름 무늬 | `cs-[hash]-[local]` | 업스트림 무늬(`[hash]_[local]`)를 쓰면 dsh 기본 요소를 숨기는 접미사 선택자(`[class$="_newSession"]`, `docs/DSH.md` "dsh 내부에 기대는 장치")가 같은 이름의 우리 클래스에도 걸린다 | 무늬 문자열 하나만 바꾼다 |
| 시험용 React 컴포넌트의 자리 | `sidebar.footer.action`(list/root)에 라이트·다크를 바꾸는 작은 버튼 | 기본 화면을 바꾸지 않고 확인할 수 있는 자리다. 값·콜백·`hooks` 셋을 다 쓰고, 테마를 바꾸는 동작이 DOM에서 확인된다. 화면 교체는 3-0의 일이다 | 3-0에서 지운다 |
| `pnpm dsh:start`가 먼저 빌드한다 | 띄우기 전에 브라우저 번들을 빌드한다. `dsh:profile`·`dsh:config`는 빌드하지 않는다 | 옛 번들이 나가는 함정을 없앤다. 빌드는 1초가 안 걸린다 | `scripts/dsh.ts`에서 그 한 줄을 뺀다 |

### 린트 규칙

`react` 플러그인을 켜면서 `.oxlintrc.json`의 `rules`에 넷을 적었다. 앞의 셋은 dsh의 쓰는 법과 부딪쳐서 껐다.

| 규칙 | 값 | 이유 |
| --- | --- | --- |
| `import/no-empty-named-blocks`, `unicorn/require-module-specifiers` | 끔 | `import type {} from "<패키지>/client"`가 걸린다. `ctx`의 서비스 타입과 슬롯 표를 붙이는 dsh의 방법이다(`docs/DSH.md` "타입을 얻는 패키지") |
| `react/hooks` | 끔 | 컴파일러식 검사가 "훅은 렌더마다 같은 함수여야 한다"며 props로 받은 훅(`useTheme`)을 막는다. dsh 슬롯은 훅을 props로 준다 |
| `react/react-in-jsx-scope` | 끔 | JSX 자동 런타임이라 `React` import가 없다 |
| `react/rules-of-hooks` | 오류 | 위 `react/hooks`를 끈 대신 이름 기반의 훅 규칙을 켰다. 조건부 호출을 잡는다(props로 받은 훅도) |

## 빌드 스크립트 명세 — `scripts/build-client.ts`

`node scripts/build-client.ts`(= `pnpm build`)로 돈다. Node가 TypeScript를 바로 실행하므로 지울 수 있는 문법만 쓴다(`erasableSyntaxOnly`, enum과 생성자 매개변수 속성 금지, 상대 import에는 `.ts` 확장자). 근거는 업스트림 `packages/client/tsdown.client.ts`의 `clientConfig`와 `packages/client/modules/README.md`다(태그 `dsh-v0.2.2-rc.5`).

**대상 찾기.** 체크아웃 뿌리의 `packages/*/package.json` 가운데 `dsh.client`가 있는 패키지를 전부 빌드한다. 하나도 없으면 아무것도 하지 않고 성공으로 끝난다. 패키지마다 아래를 확인하고 어긋나면 패키지 이름을 넣은 오류로 끝낸다.

- `dsh.client.platform`이 `"web"`이다.
- `exports["./client"]`가 `"./lib/client.js"`다(문자열이거나 `default`가 그 값인 객체).
- 진입점 `src/client/index.ts` 또는 `src/client/index.tsx`가 있다(둘 다 있으면 오류).
- `tsconfig.client.json`이 있다.
- `dsh.client.external`이 없다(아직 받지 않는다. 있으면 "지원하지 않는다"는 오류).

**esbuild 설정.** `bundle: true`, `format: "cjs"`, `platform: "browser"`, `target: "es2024"`, `jsx: "automatic"`, `tsconfig: <패키지>/tsconfig.client.json`, `outfile: <패키지>/lib/client.js`, `sourcemap: "linked"`, `sourcesContent: true`, `define: { "process.env.NODE_ENV": "\"production\"" }`, `logLevel: "warning"`, `metafile: true`. 줄이지 않는다(`minify` 없음). `charset`은 esbuild 기본값이라 ASCII가 아닌 글자는 `\uXXXX`로 나간다.

**로더 형식.** 출력은 업스트림과 같은 모양이다. 소스맵이 맞도록 문자열을 덧붙이지 않고 esbuild의 `banner.js`와 `footer.js`로 감싼다.

```
banner: window.__ModuleLoader__.load({ id: "<패키지 이름>", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
footer: return module.exports; } });
```

**공유 모듈.** 아래 열한 개만 external이다(`SHARED_MODULES` 상수 하나. 출처는 업스트림 `packages/client/web/src/platform.ts`의 `PLATFORM_MODULES`). 정확히 같은 경로만 맞춘다.

```
react  react/jsx-runtime  react-dom  react-dom/client  @deepseek-ai/cordis  zod  @tanstack/react-virtual
@deepseek-ai/dsh-client-store  @deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives  @deepseek-ai/dsh-client-ui-dockkit
```

**거절하는 import**(esbuild 플러그인의 `onResolve`에서 오류를 돌려준다. 오류 문구에 패키지 이름, import 경로, 고칠 방법이 들어 있다). `node_modules` 안의 서드파티 코드가 하는 import에도 적용된다.

- 표에 없는 `@deepseek-ai/*` — 값 import는 안 된다. 타입만 쓰면 `import type`으로 쓰고, 동작은 주입된 서비스로 받는다.
- 표에 없는 `react`, `react-dom`, `scheduler`와 그 하위 경로(예: `react-dom/server`, `react/jsx-dev-runtime`) — React 사본이 실리는 것을 막는다.
- `.module.css`가 아닌 `.css` — `*.module.css`를 쓴다.

그 밖의 서드파티 패키지는 브라우저 번들에 같이 싣는다.

**CSS Modules.** `*.module.css` import는 플러그인이 가로챈다(`onResolve`로 실제 경로를 풀어 전용 namespace에 넣고, `onLoad`에서 변환한다). lightningcss `transform`에 `cssModules: { pattern: "cs-[hash]-[local]" }`, `minify: true`를 주고, `filename`에는 `<패키지 이름>/<패키지 뿌리 기준 상대 경로>`(POSIX 구분자)를 준다. 해시가 체크아웃 위치에 따라 바뀌지 않고 패키지끼리 겹치지 않게 하기 위해서다. `composes`로 끌어온 클래스는 그 이름의 값 뒤에 띄어 붙인다. 돌려주는 모듈은 업스트림 `styleInjectionModule`과 같은 일을 한다.

```js
const css = "<변환된 CSS>";
const tagId = "<패키지 이름>/<src/client 기준 상대 경로>";   // 예: "@cs/ui-shell/BuildProbe.module.css"
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "<패키지 이름>";               // 로더가 플러그인이 내려갈 때 이 속성으로 찾아 지운다
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}
export default { "<local>": "<바뀐 이름>", … };       // 키를 정렬해 출력이 안정되게 한다
```

업스트림은 `tagId`에 파일 이름(basename)을 쓴다. 우리는 같은 이름의 파일이 다른 폴더에 있어도 되게 `src/client/` 기준 상대 경로를 쓴다.

**끝난 뒤.** 패키지마다 한 줄을 stderr에 찍는다: 패키지 이름, `lib/client.js`의 바이트 수, 같이 실린 서드파티 패키지 이름들(metafile의 입력 경로에서 뽑는다. 없으면 `none`). metafile의 입력에 `node_modules/react/`, `node_modules/react-dom/`, `node_modules/scheduler/`가 있으면 오류로 끝낸다(위 거절 규칙이 뚫렸을 때의 마지막 방어).

**내보내는 것.** `scripts/dsh.ts`가 띄우기 전에 부르도록 `buildClientBundles(root)`를 내보내고, 파일이 직접 실행됐을 때만(`import.meta.main`) 체크아웃 뿌리로 그것을 부른다. 오류는 메시지만 찍고 종료 코드 1로 끝낸다.

## 만든 것

| 파일 | 내용 |
| --- | --- |
| `scripts/build-client.ts` | 위 명세의 빌드. `pnpm build` |
| `scripts/dsh.ts` | `start`가 띄우기 전에 빌드한다 |
| `tsconfig.client.base.json` | 브라우저 프로그램의 공통 옵션(`lib`에 DOM, `jsx: react-jsx`, `module: preserve`, `moduleResolution: bundler`)과 `include`(`${configDir}/src/client`, `types/css-modules.d.ts`) |
| `types/css-modules.d.ts` | `*.module.css`의 타입(클래스 이름 표) |
| `packages/ui-shell/package.json` | `main`·`exports["."]`가 `src/index.ts`, `exports["./client"]`가 `lib/client.js`, `dsh.client`, 타입용 devDependency, `typecheck` |
| `packages/ui-shell/tsconfig.json`, `tsconfig.client.json` | 호스트 프로그램, 브라우저 프로그램 |
| `packages/ui-shell/src/index.ts` | 호스트 절반(`index.js`를 대신한다. 여전히 비어 있다) |
| `packages/ui-shell/src/client/index.ts` | 브라우저 절반의 진입점. `inject`와 `apply`만 내보낸다 |
| `packages/ui-shell/src/client/BuildProbe.tsx`, `BuildProbe.module.css`, `strings.ts` | 시험용 React 컴포넌트, 그 스타일, 화면 문자열 |
| `.oxlintrc.json` | `react` 플러그인과 규칙 넷 |

패키지의 모양:

```
packages/ui-shell/
  package.json
  tsconfig.json           호스트 프로그램
  tsconfig.client.json    브라우저 프로그램(루트의 tsconfig.client.base.json을 extends만 한다)
  src/index.ts            호스트 절반
  src/client/index.ts     브라우저 절반의 진입점: inject와 apply만 내보낸다
  src/client/*.tsx        React 컴포넌트(ctx를 보지 않는다)
  src/client/*.module.css
  src/client/strings.ts   화면 문자열(한국어)을 모은 모듈
  lib/client.js           빌드 결과(.gitignore)
```

타입용 devDependency(`@cs/ui-shell`): `@deepseek-ai/cordis` 4.1.0, `@deepseek-ai/dsh-client-store`·`-ui-primitives`·`-ui-renderer`·`-ui-sidebar`·`-ui-slots`·`-ui-theme` 0.2.2-rc.5, `@types/react` 18.3.32.

### 분담

`AGENTS.md` "구현 작업 분담"대로 `scripts/build-client.ts`는 표준 등급 서브 에이전트 하나가 위 명세로 만들었고(저장소 밖 픽스처로 형식·거절·매니페스트 검증을 확인), 지휘 세션이 읽고 한 곳을 고쳐 받았다(빌드 실패 때 esbuild가 이미 찍은 오류를 다시 붙이지 않게 했다). 나머지는 지휘 세션이 직접 했다.

## 확인한 것

전부 2026-11-26에 Node 24.22.3, pnpm 10.34.8로 했다. "띄워 확인"은 임시 `DSH_HOME`으로 `pnpm -s dsh:start --no-open --port 0`을 띄우고 헤드리스 Chromium(`playwright-core` 1.65.1, 저장소 밖의 스크립트)으로 본 것이다. 여섯 번 띄웠고 마지막 다섯 번은 콘솔 오류·경고가 0건이었다(첫 번의 1건은 확인 스크립트가 소스맵 주소를 잘못 짐작해 낸 404였다).

- [x] **TSX로 쓴 React 컴포넌트가 슬롯 하나에 그려진다**(띄워 확인). `[data-slot="sidebar.footer.action"]` 안에 시험용 버튼이 보이고 콘솔 오류가 0건이다.
- [x] **브라우저 번들에 React가 없다.** `lib/client.js`는 4,191바이트이고 `require`는 `react/jsx-runtime`과 `@deepseek-ai/dsh-client-ui-primitives` 둘뿐이다. 같이 실린 서드파티는 없다.
- [x] **`inject`가 돌려준 값·콜백·`hooks`가 props로 온다**(띄워 확인). 값 `owner`가 DOM 속성에 찍히고, 버튼을 누르면 콜백이 `ctx.theme.setTheme`을 불러 `<html>`의 `color-scheme`이 `light` → `dark` → `light`로, `<body>`의 `data-ds-dark-theme`이 없음 → 있음 → 없음으로 바뀌며, `hooks: { theme }`가 `useTheme(selector)`로 와서 글자가 "라이트" → "다크" → "라이트"로 따라 바뀐다.
- [x] **CSS Modules**(띄워 확인). `<style data-plugin="@cs/ui-shell" data-plugin-css="@cs/ui-shell/BuildProbe.module.css">`가 하나 들어가고, 클래스 `cs-W6SYKq-probe`가 걸려 `display: flex`·`gap: 6px`가 계산된다. 토큰 색이 테마를 따라 바뀐다.
- [x] **공유 부품을 값으로 쓴다**(띄워 확인). `Button`이 dsh의 클래스로 그려진다.
- [x] **호스트 절반 `.ts`**(띄워 확인). `@deepseek-ai/cordis`의 타입을 `import type`으로 쓰는 `src/index.ts`의 `apply`가 기동 때 불린다(시험 삼아 넣은 출력으로 확인하고 뺐다).
- [x] **소스맵**(띄워 확인). dsh가 우리 번들이 든 묶음 스크립트 끝에 맵 참조를 붙이고, 그 맵(Indexed Source Map)에 `BuildProbe.tsx`가 소스 내용과 함께 들어 있다.
- [x] **빌드가 거절한다.** 실제 패키지에 임시로 넣어 봤다: `@deepseek-ai/dsh-client-ui-theme/client`의 값 import, `import { type X } from` 꼴(아래 "알게 된 것"), `react-dom/server`, 맨 `.css`. 넷 다 종료 코드 1이고 문구에 고칠 방법이 나온다. `zod`와 `@tanstack/react-virtual`은 external로 남는다.
- [x] **타입 검사가 실제로 건다.** 일부러 넣은 오류 여덟을 브라우저 프로그램이 잡았다: 없는 슬롯 이름, 목록 슬롯에 `id` 없는 등록, `ctx.theme`의 없는 멤버, 타입을 불러오지 않은 서비스(`ctx.sidebarRight`), 슬롯 props의 타입 불일치, `useTheme` 선택자의 없는 멤버, `hooks`를 props로 받으려는 것, `node:fs` import. 호스트 프로그램은 `document`를 잡았다.
- [x] **린트가 건다.** 조건부 훅 호출과 `key` 누락을 잡는다.
- [x] `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`가 통과한다. `pnpm dsh:profile`·`pnpm -s dsh:config`도 그대로 된다.

서브 에이전트가 픽스처로 확인한 것(지휘 세션은 다시 돌리지 않았다): 매니페스트 검증 다섯 가지(`platform`, `exports["./client"]`가 틀리거나 없음, 진입점 없음, 진입점 둘, `dsh.client.external`)가 각각 오류를 내는 것, `dsh.client`가 있는 패키지가 없는 뿌리에서 아무 일도 하지 않는 것, `composes`.

확인하지 못한 것:

- 서드파티 패키지가 실제로 같이 실리는 경우(지금 번들에는 없다)와 `zod/v4` 같은 공유 모듈의 하위 경로.
- metafile의 React 방어(거절 규칙이 먼저 막아서 닿지 않는다).
- 슬롯 등록의 `store` 칸과 `locale` 칸.
- 플러그인이 내려갈 때 dsh 로더가 우리 `<style>`을 지우는 것(소스 확인만 했다).

## 하다가 알게 된 것

`docs/DSH.md`에 옮겨 적었다.

- **dsh를 띄워 둔 채 `lib/client.js`가 바뀌면 새로고침 없이 화면이 새 번들로 바뀐다**(띄워 확인). 파일을 바꾸고 1.5초 뒤에 이미 바뀌어 있었고 콘솔 오류는 없었다. 그래서 개발할 때는 dsh를 띄워 두고 `pnpm build`만 다시 돌리면 된다.
- `@deepseek-ai/dsh-client-ui-slots`의 타입은 `@deepseek-ai/dsh-client-store`에서 훅 타입을 가져오는데, 이 패키지는 의존성으로 따라오지 않는다. 따로 devDependency에 넣지 않으면 `skipLibCheck` 아래에서 그 타입들이 조용히 `any`가 된다.
- `@deepseek-ai/dsh`를 설치해도 `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-store`는 `node_modules`에 들어오지 않는다. 타입을 쓰려면 직접 넣는다.
- `verbatimModuleSyntax` 아래에서 `import { type X } from "…"`는 `import {} from "…"`로 남아 값 import가 된다. 표 밖의 `@deepseek-ai/*`면 빌드가 거절한다. `import type { X } from "…"`로 쓴다.
- `ctx.theme`: `getTheme()`은 다음 변경까지 같은 객체를 돌려주고, 바뀌면 `theme/change` 이벤트가 온다. 이 둘이 `hooks`가 받는 모양(`getSnapshot`·`subscribe`)과 맞는다. `setTheme("light" | "dark")`는 `<html>`의 `color-scheme`과 `<body>`의 `data-ds-dark-theme`(다크일 때만 빈 값으로 있다)을 바꾼다.
- 업스트림 프리셋은 CSS를 세 가지로 받는다: `x.module.css`(클래스 표 + 팩토리 실행 때 주입), 맨 `x.css`(전역, 같은 식으로 주입), `x.css?inline`(문자열로 받아 플러그인이 직접 넣는다). 우리는 첫째만 받는다.
- 임시 home으로 처음 띄우면 "Unable to create default workspace. Use Choose workspace to select a folder." 토스트가 뜬다(관찰. 콘솔 오류는 아니다. 원인은 보지 않았다).
- 확인에 쓴 환경에는 한국어 글꼴이 없어서 스크린샷의 한국어가 네모로 나온다. DOM의 글자는 맞다.

## 계획과 달라진 점

- 로드맵은 `react` 플러그인만 "정할 것"으로 적었다. 켜 보니 dsh의 쓰는 법과 부딪치는 규칙이 셋 있어 같이 정했다("린트 규칙").
- 빌드가 `tsconfig.client.json`이 있는지도 본다(명세에 없던 검사).
- `pnpm dsh:start`가 먼저 빌드하게 했다(로드맵에 없던 것).

## 후속

- Vitest와 조합 시험(1-2). 이번에 저장소 밖에서 돌린 확인 스크립트가 그 출발점이다. `playwright-core`는 아직 이 저장소의 의존성이 아니다.
- `pnpm build --watch`는 만들지 않았다. dsh가 바뀐 번들을 스스로 받으므로 esbuild의 watch를 붙이면 저장만으로 화면이 바뀐다. 필요해지면 더한다.
- 슬롯 등록의 `store`·`locale` 칸은 3-0에서 처음 쓴다.
- 이 문서의 "Claude가 고른 기본값"은 사용자가 확인하지 않았다. PR에서 본다.
