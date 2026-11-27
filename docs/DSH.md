# dsh에 얹는 방법

DeepSeek Harness(dsh) 위에 이 프로젝트를 올릴 때 알아야 하는 것을 모았다. 항목마다 확인 수준이 다르므로 표시를 본다(뜻은 `AGENTS.md` "확인 수준").

- **띄워 확인** — dsh 0.2.2-rc.5를 실제로 실행하고 헤드리스 Chromium(Chrome for Testing 153)으로 확인했다(2026-11-24~25, 콘솔 오류 0건). 1-0에서 이 저장소의 틀로 다시 띄운 것은 날짜(2026-11-26)를 따로 적었다.
- **소스 확인** — 업스트림 저장소의 태그 `dsh-v0.2.2-rc.5`에서 소스나 문서를 읽었다. 실행하지는 않았다. "소스 확인(DreamVerse)"는 DreamVerse 포크(dsh 0.1.7-rc.1에서 갈라짐)의 소스에서 읽었다는 뜻이고, 0.2.2-rc.5에서도 되는지는 말하지 않는다.
- **미확인** — 아직 확인하지 못했다. 맨 아래 "확인하지 못한 것"에 모았다.

**경로 읽는 법**: 이 문서에서 "업스트림"이라고 한 `docs/…`와 `packages/…` 경로는 dsh 저장소 안의 경로다(소문자 파일 이름). 이 저장소의 문서는 `docs/ARCHITECTURE.md`처럼 대문자 이름이다.

확인에 쓴 시험 코드는 이 저장소에 없다(검토용이었고 지웠다). 다시 확인하려면 "띄워서 확인하는 법"을 따른다. 이 문서의 코드 조각은 그때 실제로 돌린 것에서 추렸다. 그 시험 코드는 빨리 확인하려고 업스트림의 브라우저 코드 규칙을 따르지 않았다("업스트림의 브라우저 코드 규칙"의 주의).

## 기본 정보

| 항목          | 값                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 저장소        | https://github.com/deepseek-ai/deepseek-harness (기본 브랜치 `master`, MIT, 외부 PR을 받지 않는다)                       |
| 쓰는 버전     | `@deepseek-ai/dsh` **0.2.2-rc.5** — 태그 `dsh-v0.2.2-rc.5`, 커밋 `9c2670d3bc`, 2026-11-18                                |
| npm           | dist-tag `latest`·`next`가 0.2.2-rc.5, `alpha`가 0.2.3-alpha.2다(2026-11-25). `@deepseek-ai/*` 약 340개가 함께 설치된다. |
| 버전 줄       | `@deepseek-ai/dsh`와 `@deepseek-ai/dsh-*`는 같은 버전(0.2.2-rc.5)이다. `@deepseek-ai/cordis`는 4.1.0, `@deepseek-ai/schemastery`는 3.19.0으로 줄이 따로다. |
| 요구 사항     | Node.js 24.9.0 이상                                                                                                      |
| 구조          | Cordis 플러그인. 플러그인 하나에 호스트 절반(Node)과, 있으면 브라우저 절반이 있다.                                       |
| 웹 클라이언트 | React 18.3.1. 플러그인의 브라우저 절반과 React를 공유한다.                                                               |

CLI(소스 확인, 일부 띄워 확인):

```
dsh --profile <name> [options]            프로필을 띄운다. `dsh web`은 `dsh --profile web`과 같다.
dsh plugin --profile <name> <pnpm-args>   프로필 디렉터리에서 pnpm을 부른다. 예: add <경로|git|npm>
  --from-default-profile <name>           기본 제공 템플릿으로 프로필을 새로 만든다. 있던 프로필은 덮어쓴다.
  --patch <path>                          패치 파일을 덧씌운다(여러 번 가능).
  --dump-config                           합성된 프로필 구성을 찍고 끝낸다.
웹 앱 옵션: --host <주소> --port <포트>(0이면 빈 포트) --no-open
            --public-url <url> --trusted-host <authority> --tls-cert <파일> --tls-key <파일>
```

## 얹는 방법: 프로필과 번들

- **프로필**은 `$DSH_HOME/profiles/<name>/` 디렉터리다. 어떤 번들을 어떤 순서로 쌓는지와 사용자 설정을 가진다.
- **번들**은 `package.json`의 `dsh.bundle.patch`로 패치 파일을 가리키는 npm 패키지다. 패치 파일은 플러그인 행을 넣거나 덮는 YAML이다. 패치 파일을 여러 개 적을 수도 있다(`dsh-web-app`이 그렇다).
- **합성 순서**(**소스 확인**: 업스트림 `docs/user/develop/basic/publish.md` "The loading order"): 빈 뿌리 → 프로필 `package.json`의 `dsh.profile.bundles`에 적힌 번들을 순서대로 → 프로필의 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`(그 home의 모든 프로필에 공통) → `--patch`(준 순서대로). 뒤 계층이 행 단위로 이긴다. 패치는 행의 `config` 전체를 바꾼다(키별로 합치지 않는다). 그래서 앞 계층의 행을 `id`로 덮을 때는 그 행에 필요한 키를 전부 다시 적는다.

아래 구성은 2026-11-24에 그대로 동작했다(**띄워 확인**). 지금은 `scripts/dsh.ts`가 같은 일을 한다: `pnpm dsh:profile`이 처음 두 명령을, `pnpm dsh:start`가 그 둘과 셋째를 한다(`AGENTS.md` "명령").

프로필 만들기와 실행:

```sh
export DSH_HOME="$PWD/.dsh-home"   # 그때는 저장소 안에 두었다. 어디에 둘지는 아래 "워크트리와 DSH_HOME"
# web 템플릿에서 프로필을 만든다. 있던 프로필을 덮어쓰므로 처음 한 번만 한다.
pnpm exec dsh --profile comfy-studio --from-default-profile web --dump-config > /dev/null
# 우리 번들을 프로필에 넣는다. 절대 경로로 링크된다.
pnpm exec dsh plugin --profile comfy-studio add "$PWD/packages/bundle"
# 띄운다.
pnpm exec dsh --profile comfy-studio --no-open --port 8092
```

그 결과 프로필의 `package.json`:

```json
{
  "name": "dsh-profile-comfy-studio",
  "private": true,
  "dependencies": { "@cs/bundle": "link:/절대/경로/packages/bundle" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@cs/bundle"] } }
}
```

번들 패키지(`packages/bundle`):

```json
{
  "name": "@cs/bundle",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": ">=0.2.2-rc.5 <0.3.0" },
  "dependencies": { "@cs/ui-shell": "workspace:*" }
}
```

```yaml
# packages/bundle/cordis.patch.yml — 플러그인 행을 넣는다. 설정은 행의 `config`에 둔다.
- insert:
    - id: cs-ui-shell
      name: '@cs/ui-shell'
```

알아 둘 것:

- 번들은 자기가 넣는 플러그인 패키지에 의존한다(위의 `dependencies`).
- 패치가 빈 배열(`[]`)인 번들도 기동한다. 그때 `--dump-config`에는 그 번들의 머리 줄이 나오지 않는다(**띄워 확인**, 2026-11-25).
- `--from-default-profile`은 프로필 디렉터리에 `package.json`, `cordis.yml`, `cordis.patch.yml`, `pnpm-workspace.yaml` 넷만 만든다. `node_modules`는 `dsh plugin add`를 처음 돌릴 때 생긴다. `dsh-base`와 `dsh-web-app`은 프로필이 아니라 dsh를 설치한 쪽에서 풀린다(**띄워 확인**, 2026-11-25).
- 프로필의 `pnpm-workspace.yaml`은 `nodeLinker: hoisted`다.
- 설정 화면에서 바꾼 값은 프로필의 `cordis.patch.yml`에 쓰인다.
- 합성된 구성은 203행이다(`dsh-base`와 `dsh-web-app`이 202행. 2026-11-26에 이 저장소의 틀로 다시 셌다). `--dump-config`는 행 묶음마다 어느 계층의 것인지 `# == <번들 이름>` 머리 줄을 찍는다(우리 번들의 행은 `# == @cs/bundle` 아래에 나왔다). 자주 볼 행 id: `llm-pi-ai`, `llm-deepseek`, `credentials`, `storage`, `storage-json`, `storage-domain`, `schedule`, `mcp-manager`, `skill`, `subagent`, `web-search-deepseek`, `webserver`, `web-runtime`, `connection`, `locale`, `ui-theme`, `ui-layout`, `ui-sidebar`, `ui-sidebar-right`, `ui-conversation`, `ui-settings`, `agent-preset-registry`, `preset-standard`.
- 업스트림 안내: `docs/user/develop/basic/publish.md`.

### 워크트리와 DSH_HOME

`DSH_HOME`에는 프로필(설정 화면에서 바꾼 값 포함), 자격 증명(`.credentials.yaml`, 모델 키), 세션이 들어 있다. 프로필은 번들을 **절대 경로**로 링크한다. 이 저장소의 작업은 단계마다 `.worktree/<이름>`에서 하고 병합 뒤 그 워크트리를 지운다(`AGENTS.md` "브랜치·커밋·병합"). 이 셋이 부딪친다.

**정해진 방식**(사용자가 고름, 2026-11-26): **본 체크아웃의 `.dsh-home` 하나를 모든 워크트리가 같이 쓰고, 스크립트가 띄울 때마다 번들 링크를 지금 워크트리로 다시 건다.** 모델 키와 설정이 단계를 넘어 남는다.

- `scripts/dsh-env.ts`가 `git rev-parse --git-common-dir`로 본 체크아웃을 찾아 그 아래 `.dsh-home`을 home으로 쓴다. 어느 워크트리에서 돌려도 같은 home이다. `.gitignore`에 들어 있다.
- `pnpm dsh:profile`·`dsh:start`·`dsh:config`는 먼저 프로필을 맞춘다. 프로필이 없으면 `web` 템플릿으로 만들고(`--from-default-profile`은 있던 프로필을 덮어쓰므로 없을 때만 돌린다), 프로필 `package.json`의 `@cs/bundle` 링크가 지금 체크아웃의 `packages/bundle`이 아니면 `dsh plugin --profile comfy-studio add <그 경로>`로 다시 건다.
- 다시 거는 데는 약 0.5초가 걸린다. `bundles` 목록에 번들이 겹쳐 들어가지 않고 프로필의 `cordis.patch.yml`(설정 화면에서 바꾼 값)은 그대로 남는다(**띄워 확인**, 2026-11-25).
- **링크는 한 번에 한 워크트리만 가리킨다.** 한 워크트리에서 띄워 둔 채 다른 워크트리에서 띄우면 먼저 띄운 쪽의 링크가 바뀐다. 두 곳에서 동시에 띄울 때는 한쪽에 `DSH_HOME=<다른 경로>`를 준다. 환경 변수가 있으면 스크립트는 그 경로를 쓴다.
- 워크트리를 지운 뒤에는 링크가 없는 경로를 가리킨다. 다음에 어느 체크아웃에서든 `pnpm dsh:profile`이나 `pnpm dsh:start`를 돌리면 다시 걸린다(**띄워 확인**, 2026-11-26).
- 시험은 임시 home을 쓴다("띄워서 확인하는 법"). 개발용 home의 키와 설정을 건드리지 않는다.
- 버린 안: 워크트리마다 home을 두는 것(워크트리를 지우면 모델 키와 설정이 같이 사라진다), 저장소 밖에 공용 home을 두는 것.

## 플러그인 패키지 하나의 모양

호스트 절반은 패키지의 기본 진입점이고, 브라우저 절반은 `exports["./client"]`다(**띄워 확인**).

```json
{
  "name": "@cs/ui-shell",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-renderer"] } }
}
```

```ts
// src/index.ts — 호스트 절반. 브라우저 절반만 있는 패키지도 이 파일은 있어야 한다.
import type { Context } from "@deepseek-ai/cordis";
export const name = "cs-ui-shell";
export function apply(_ctx: Context): void {}
```

패키지 안의 자리(1-1에서 정했다. `docs/archive/PLAN_1-1.md` "만든 것"):

```
package.json
tsconfig.json           호스트 프로그램(src/ 중 src/client/ 밖, Node 타입)
tsconfig.client.json    브라우저 프로그램(src/client/, DOM, JSX). 루트의 tsconfig.client.base.json을 extends만 한다
src/index.ts            호스트 절반
src/client/index.ts     브라우저 절반의 진입점
src/client/*.tsx, *.module.css, strings.ts
lib/client.js           브라우저 번들(빌드 결과, .gitignore)
```

- **호스트 절반은 `.ts` 그대로 내보낸다**(1-1에서 정했다. `docs/DECISIONS.md` "확정", 2026-11-27). 빌드하지 않는다. 그래서 지울 수 있는 문법만 쓰고(enum·생성자 매개변수 속성 금지) 상대 import에는 `.ts` 확장자를 붙인다. `@deepseek-ai/cordis`의 타입을 `import type`으로 쓰는 `src/index.ts`의 `apply`가 기동 때 불린다(**띄워 확인**, 2026-11-26).
- 호스트 절반만 있는 플러그인은 `exports["./client"]`와 `dsh.client`를 빼면 된다(1-0의 빈 플러그인이 그 모양이었다).
- `dsh.client`가 있으면 `./client` export가 반드시 있어야 한다. 없으면 기동이 실패한다(**소스 확인**).
- `dsh.client.inject`는 패키지 이름 목록이고 정보용이다. 실행 순서를 정하지 않는다. 순서는 Cordis가 `inject`에 적힌 **서비스**를 기다리는 것으로만 정해진다(**소스 확인**: 업스트림 `packages/client/AGENTS.md`).
- 브라우저 번들은 **띄우기 전에 빌드돼 있어야** 한다. dsh는 소스가 아니라 `lib/client.js`를 내보낸다. `pnpm dsh:start`는 띄우기 전에 빌드한다.
- 호스트 절반만 있는 플러그인을 우리 번들로 띄우면 기동 때 `apply(ctx)`가 불린다(**띄워 확인**, 2026-11-25).
- 링크된 패키지의 호스트 절반을 `.ts`로 두고 `main`과 `exports["."]`가 그 파일을 가리키게 해도 Node 24.22.3이 바로 읽는다(**띄워 확인**, 2026-11-25~26). Node 문서에 따르면 타입 지우기는 지울 수 있는 문법만 받고(enum·생성자 매개변수 속성은 안 된다) `node_modules` 안의 파일에는 적용되지 않는다. 링크된 패키지는 실제 경로로 풀려서 걸리지 않은 것으로 보인다(추정). 그래서 패키지를 링크가 아니라 타르볼로 설치하게 되면 호스트 절반도 JavaScript로 빌드해야 한다.

## 브라우저 절반

### 브라우저 번들 형식

dsh의 브라우저 쪽 모듈 로더는 아래 형식의 스크립트를 받는다. 업스트림의 빌드 프리셋(tsdown `clientBundle`, 업스트림 `packages/client/tsdown.client.ts`)은 저장소 안에만 있고 npm에 없어서, 같은 형식을 `scripts/build-client.ts`가 esbuild로 만든다(**띄워 확인**, 2026-11-26). 명세는 `docs/archive/PLAN_1-1.md` "빌드 스크립트 명세"에 있다.

```js
window.__ModuleLoader__.load({ id: "@cs/ui-shell", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
/* esbuild가 만든 CJS 본문. 공유 모듈은 여기서 require("react/jsx-runtime")처럼 부른다 */
return module.exports; } });
//# sourceMappingURL=client.js.map
```

- `pnpm build`가 `packages/*` 가운데 `dsh.client`가 있는 패키지를 전부 빌드한다. 진입점은 `src/client/index.ts`(또는 `.tsx`), 결과는 `lib/client.js`와 `lib/client.js.map`이다.
- 번들을 실행하는 것은 팩토리를 등록할 뿐이고, 모듈 본문은 플러그인이 처음 쓰일 때 실행된다(**소스 확인**: 업스트림 `packages/client/modules/README.md` "Lazy-CJS model").
- **external은 공유 모듈 열한 개뿐이다**(아래 표). 정확히 같은 경로만 맞춘다.
- **빌드가 거절하는 import**: 표에 없는 `@deepseek-ai/*`의 값 import, 표에 없는 `react`·`react-dom`·`scheduler`와 그 하위 경로, `.module.css`가 아닌 `.css`. 업스트림 프리셋의 "purity" 게이트를 본뜬 것이다(업스트림은 일부 `@deepseek-ai/*` 계약 패키지를 싣도록 허용한다. 우리는 아직 허용 목록이 없다).
- 타입만 가져오는 import는 esbuild가 지우므로 걸리지 않는다. 다만 `verbatimModuleSyntax` 아래에서 `import { type X } from "…"`는 `import {} from "…"`로 남아 값 import가 된다. **`import type { X } from "…"`로 쓴다**(2026-11-26에 빌드가 거절하는 것을 봤다).
- 그 밖의 서드파티 패키지는 브라우저 번들에 같이 실린다. 빌드가 끝나면 패키지마다 크기와 같이 실린 패키지 이름을 찍는다.
- 진입점은 TSX와 JSX 자동 런타임을 쓴다(`react/jsx-runtime`은 공유 표에 있다).
- 줄이지 않는다. ASCII가 아닌 글자는 `\uXXXX`로 나간다(esbuild 기본값).
- **소스맵**: dsh는 플러그인 번들을 묶음 스크립트(`/plugins/??…`)로 내보내고 그 끝에 묶음 맵의 참조를 붙인다. 그 맵(Indexed Source Map)에 우리 `.tsx`가 소스 내용과 함께 들어 있다(**띄워 확인**, 2026-11-26). `/plugins/<패키지>/client.js.map`이라는 주소는 없다(404).
- `dsh.client.external`은 우리 빌드가 아직 받지 않는다(있으면 오류).

### CSS

**CSS Modules로 싣는다**(1-1에서 정했다. `docs/DECISIONS.md` "확정", 2026-11-27). `x.module.css`를 import하면 클래스 이름 표를 받는다.

```tsx
import styles from "./BuildProbe.module.css";
<div className={styles.probe} />     // 실제 클래스는 cs-W6SYKq-probe 같은 모양이다
```

- 빌드가 lightningcss로 클래스 이름을 `cs-[hash]-[local]`로 바꾸고, CSS를 번들 안에 문자열로 넣는다. 팩토리가 실행될 때 `<style data-plugin="<패키지>" data-plugin-css="<패키지>/<파일>">`로 `<head>`에 들어간다(**띄워 확인**, 2026-11-26).
- 업스트림 프리셋과 같은 방식이다. dsh 로더는 플러그인이 내려갈 때 `style[data-plugin]`이 그 패키지인 태그를 지운다(**소스 확인**: 업스트림 `packages/client/modules/src/client/entry-lifecycle.ts`. 내려 보지는 않았다).
- 클래스 이름 무늬가 업스트림(`[hash]_[local]`)과 다른 것은 일부러다. dsh 기본 요소를 숨기는 접미사 선택자(`[class$="_newSession"]`, "dsh 내부에 기대는 장치")가 우리 클래스에 걸리지 않게 한다.
- 클래스가 없는 선택자는 바뀌지 않고 그대로 나간다. `button[class$="_newSession"]` 같은 속성 선택자와 `:global(.이름)`이 그렇다(lightningcss 1.33.0으로 변환해 봤다, 2026-11-26). 그래서 dsh 기본 요소를 숨기는 규칙도 `.module.css`에 둘 수 있다.
- `.module.css`가 아닌 `.css`는 빌드가 거절한다. 업스트림 프리셋은 맨 `x.css`(전역 주입)와 `x.css?inline`(문자열)도 받는다. 필요해지면 `scripts/build-client.ts`에 더한다.
- 타입은 루트의 `types/css-modules.d.ts`가 준다(`Readonly<Record<string, string>>`).

### 공유 모듈 표

브라우저 절반이 external로 둘 수 있는 것은 셸이 미리 심어 둔 아래 열한 개뿐이다(`packages/client/web/src/platform.ts`의 `PLATFORM_MODULES`, **소스 확인**).

```
react  react/jsx-runtime  react-dom  react-dom/client  @deepseek-ai/cordis  zod  @tanstack/react-virtual
@deepseek-ai/dsh-client-store  @deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives  @deepseek-ai/dsh-client-ui-dockkit
```

- 표에 있는 것은 브라우저 번들에 싣지 않는다. 실으면 React가 둘이 된다.
- 표에 없는 서드파티 라이브러리는 브라우저 번들에 같이 실린다(private copy).
- 표에 없는 `@deepseek-ai/*`에서 **값**을 가져오면 안 된다. 타입만 가져오는 것은 괜찮다.
- 표 밖의 dsh 모듈이 꼭 필요하면 `dsh.client.external`에 정확한 import 경로를 적는 길이 있다. 업스트림은 이것을 기능 플러그인의 의존 수단으로 쓰지 말라고 한다(**소스 확인**).
- 버전(dsh 0.2.2-rc.5가 싣는 것): React 18.3.1, zod 4.6.6, `@tanstack/react-virtual` 3.14.10.

### 타입을 얻는 패키지

타입은 dsh 패키지를 devDependency로 넣어 얻는다. 값이 아니라 **타입만** 가져온다(`import type`). npm에서 이 패키지들의 `latest`는 옛 버전이므로(예: `dsh-client-ui-primitives`는 0.0.1-rc.1) **`0.2.2-rc.5`를 명시**한다. `@deepseek-ai/cordis`만 4.1.0이다. `@types/react`는 18을 쓴다.

`ctx`의 서비스 타입은 그 서비스를 선언한 패키지의 `/client` 진입점을 타입으로 불러오면 붙는다(선언 병합). 예: `import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'`.

| 쓰려는 것                                  | 타입이 선언된 패키지(**소스 확인**)                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `ctx.slots`                                | `@deepseek-ai/dsh-client-ui-renderer/client`                                                                                 |
| `ctx.sidebarRight`, `ctx.sidebarRightTabs` | `@deepseek-ai/dsh-client-ui-sidebar-right/client`                                                                            |
| `ctx.workspaces`                           | `@deepseek-ai/dsh-api-workspace-controller/client`                                                                           |
| `ctx.sessions`                             | `@deepseek-ai/dsh-api-session-controller/client`                                                                             |
| `ctx.uiWorkspace`                          | `@deepseek-ai/dsh-client-ui-workspace/client`                                                                                |
| `ctx.theme`                                | `@deepseek-ai/dsh-client-ui-theme/client`                                                                                    |
| `ctx.layout`                               | `@deepseek-ai/dsh-client-ui-layout/client`                                                                                   |
| `ctx.locale`                               | `@deepseek-ai/dsh-client-locale/client`                                                                                      |
| 슬롯 이름과 그 props                       | 그 슬롯을 선언한 패키지의 `/client`(대화는 `dsh-client-ui-conversation`, 세션 훅은 `dsh-client-ui-session`, 사이드바는 `dsh-client-ui-sidebar`) |
| 슬롯 props의 타입 도구                     | `@deepseek-ai/dsh-client-ui-slots`(`PropsRuntime<'슬롯 이름'>`, `PropsRenderSlots`, `PropsRenderFactories`, `InjectFace`)    |
| id 타입                                    | `@deepseek-ai/dsh-session/types`(`SessionId`), `@deepseek-ai/dsh-workspace/types`(`WorkspaceId`)                             |

- DreamVerse의 `@dv/ui-shell`은 devDependency로 `cordis`, `dsh-api-session-controller`, `dsh-api-workspace-controller`, `dsh-client-locale`, `dsh-client-ui-conversation`, `dsh-client-ui-layout`, `dsh-client-ui-primitives`, `dsh-client-ui-renderer`, `dsh-client-ui-session`, `dsh-client-ui-sidebar`, `dsh-client-ui-sidebar-right`, `dsh-client-ui-slots`, `dsh-client-ui-workspace`, `dsh-session`, `dsh-workspace`를 둔다(**소스 확인(DreamVerse)**).
- npm에 올라온 0.2.2-rc.5 패키지에 타입 선언이 실려 있다. 이 타입으로 `@cs/ui-shell`의 브라우저 절반을 타입 검사한다(2026-11-26). 타입이 실제로 걸리는지는 일부러 틀린 코드로 봤다: 없는 슬롯 이름, 목록 슬롯에 `id` 없는 등록, 서비스의 없는 멤버, 타입을 불러오지 않은 서비스, 슬롯 props와 `use<이름>` 선택자의 타입이 모두 오류가 된다.
- **`@deepseek-ai/dsh-client-store`를 devDependency에 같이 넣는다.** `dsh-client-ui-slots`의 타입이 훅 타입(`SnapshotSelectorHook` 등)을 거기서 가져오는데 의존성으로 따라오지 않는다. 빠지면 `skipLibCheck` 아래에서 그 타입들이 조용히 `any`가 된다(2026-11-26).
- `@deepseek-ai/dsh`를 설치해도 `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-store`는 `node_modules`에 들어오지 않는다. 쓰는 패키지가 직접 넣는다(2026-11-26).
- `@cs/ui-shell`이 지금 두는 것: `cordis` 4.1.0, `dsh-client-store`, `dsh-client-ui-primitives`, `dsh-client-ui-renderer`, `dsh-client-ui-sidebar`, `dsh-client-ui-slots`, `dsh-client-ui-theme`(0.2.2-rc.5), `@types/react` 18.3.32.
- 브라우저 프로그램의 `tsconfig`는 `moduleResolution: bundler`, `module: preserve`, `jsx: react-jsx`, `lib`에 DOM이다(루트 `tsconfig.client.base.json`). Node 타입은 넣지 않는다.
- oxlint의 `import/no-empty-named-blocks`와 `unicorn/require-module-specifiers`는 `import type {} from …`을 막으므로 껐다. `react/hooks`(컴파일러식 검사)는 props로 받은 훅을 막으므로 끄고, 대신 `react/rules-of-hooks`를 켰다(`docs/archive/PLAN_1-1.md` "린트 규칙").

### 진입점

브라우저 절반은 `inject`(기다릴 서비스 이름)와 `apply(ctx)`를 export한다(**띄워 확인**).

```ts
// packages/ui-shell/src/client/index.ts에서 추렸다(2026-11-26).
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client"; // ctx.slots
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client"; // 슬롯 sidebar.*
import type {} from "@deepseek-ai/dsh-client-ui-theme/client"; // ctx.theme
import { BuildProbe, type BuildProbeInjected } from "./BuildProbe.tsx";

export const inject = ["slots", "theme"];

export function apply(ctx: Context): void {
  // 슬롯 등록은 아래 "슬롯" 참고
}
```

- 스타일은 CSS Modules로 싣는다(위 "CSS"). 2026-11-24에 확인한 다른 방식은 문자열 CSS를 `ctx.effect` 안에서 `<style>`로 넣고 그 정리 함수에서 빼는 것이다. 지금은 쓰지 않는다.
- `ctx.slots.inject(…)`는 `apply`에서 바로 부른다(업스트림 패키지들이 그렇게 쓴다). 2026-11-24~25의 시험 코드는 `ctx.effect(() => ctx.slots.inject(…))`로 감쌌고 그것도 동작했다.

### 업스트림의 브라우저 코드 규칙

업스트림 `packages/client/AGENTS.md`와 `docs/subsystems/slots.md`가 저장소 안 패키지에 요구하는 규칙이다(**소스 확인**). 우리도 따른다.

- **React 컴포넌트는 `ctx`를 보지 않는다.** `ctx`는 `apply`와, 등록할 때 넘기는 `inject` 함수 안에서만 쓴다.
- React 컴포넌트가 받는 것은 슬롯이 주는 props다: 부모가 준 데이터, `renderSlot`, `renderFactorySlot`, 틀이 만든 훅(`useSession`, `useSessions`, `useWorkspaces`, `useStore` 등. 전체 목록은 업스트림 `docs/subsystems/slots.md` "Framework-provided hooks"), 그리고 등록 때 `inject`가 돌려준 값과 콜백.
- 바뀌는 값이 오는 길은 셋이다: 부모의 props, React 컴포넌트의 지역 상태, 등록 때 선언한 store. React 컴포넌트 안에서 `useSyncExternalStore`로 직접 구독하지 않는다. 등록자만 아는 반응형 값은 `inject`가 돌려주는 객체의 `hooks` 칸에 넣으면(`getSnapshot`·`subscribe`를 가진 값) 틀이 `use<이름>(selector)` 훅으로 바꿔 준다.
- `/client` 진입점은 `apply`와 `inject`(있으면 `Config`)만 값으로 export한다. React 컴포넌트가 타입으로만 쓰는 store 팩토리는 예외다.
- 기능 플러그인이 다른 기능 플러그인의 값을 런타임에 import하지 않는다. 동작은 주입된 서비스로, UI는 슬롯으로 넘긴다.
- 등록은 `apply` 안에서만 한다. 모듈 최상위에 부작용을 두지 않는다.
- 색은 토큰으로, 화면 문자열은 로케일 사전으로. 문자열 쪽은 이 저장소에서 1-6까지 미뤘다(`AGENTS.md`의 임시 규칙).

**주의**: 2026-11-24~25의 시험 코드는 빨리 확인하려고 `ctx`의 값을 모듈 변수와 수동 구독으로 React 컴포넌트에 넘겼다. "화면 교체"와 "채팅을 우측 탭으로 옮기는 코드"의 조각은 그때의 동작 확인용이다. 실제 구현은 위 규칙대로 쓴다. 규칙대로 쓴 등록 가운데 `inject`(값, 콜백)와 `hooks`는 1-1에서 **띄워 확인**했다(2026-11-26, `packages/ui-shell/src/client`). `store`와 `locale` 칸은 아직 띄워 보지 않았다.

## 슬롯

화면의 모든 자리는 슬롯이다. 플러그인은 슬롯에 React 컴포넌트를 등록한다(**띄워 확인**).

```js
ctx.effect(() => ctx.slots.inject('main.conversation', () =>
  ctx.slots.register({ name: 'main.conversation', priority: -1 }, Center)))
```

- `ctx.slots.inject(이름, 등록 함수)`는 그 슬롯이 선언될 때까지 기다렸다가 등록하고, 선언이 사라지면 뺀다. 다른 패키지의 슬롯에 등록할 때는 항상 이 형태를 쓴다.
- 슬롯 종류(**소스 확인**): `single`(우선순위가 이긴 하나만 그린다), `list`(여럿, `id`로 구분), `keyed`(`key`로 고른다), `chain`(먼저 맞는 것), `hoc`(바깥을 감싼다).
- `priority`는 **낮을수록 이긴다.** 기본 항목이 있는 `single` 슬롯에 `priority: -1`로 등록하면 그 자리가 교체된다.
- 범위(`scope`): `root`, `session`, `session-maybe`. 세션 범위 슬롯의 React 컴포넌트는 `sessionId`를 props로 받는다.
- **Factory 슬롯**은 여러 곳에서 다시 그릴 수 있게 선언된 조립이다. 슬롯 props의 `renderFactorySlot(이름, 속성, { slots })`으로 그린다. 대화 본문 `conversation.content`가 그렇다("채팅을 우측 탭으로 옮기는 코드").
- 소스에서 찾은 슬롯 선언은 약 180개다(시험용 포함). 전체 목록은 업스트림 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`에 있다.

규칙대로 `ctx`의 값을 React 컴포넌트에 넘기는 등록(**띄워 확인**, 2026-11-26. `packages/ui-shell/src/client`에서 추렸다. 근거는 업스트림 `docs/subsystems/slots.md` "Developer-provided injection"):

```tsx
// BuildProbe.tsx — React 컴포넌트. ctx를 보지 않는다.
interface Observable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }

export interface BuildProbeInjected {
  owner: string;                                        // 값
  setColorScheme(scheme: "light" | "dark"): void;       // 콜백
  hooks: { theme: Observable<ThemeSnapshot> };          // 관찰 가능한 값. `useTheme(selector)`로 온다
}
type Props = PropsRuntime<"sidebar.footer.action"> & InjectFace<BuildProbeInjected>;

export function BuildProbe({ wide, owner, setColorScheme, useTheme }: Props) {
  const scheme = useTheme((snapshot) => snapshot.active.colorScheme);
  return <Button onClick={() => setColorScheme(scheme === "dark" ? "light" : "dark")}>…</Button>;
}

// index.ts — apply 안. ctx의 서비스는 여기서만 쓴다.
const theme = {
  getSnapshot: () => ctx.theme.getTheme(),
  subscribe: (listener: () => void) => ctx.on("theme/change", listener),
};
ctx.slots.inject("sidebar.footer.action", () =>
  ctx.slots.register({
    name: "sidebar.footer.action", id: "cs-build-probe",
    inject: (): BuildProbeInjected => ({
      owner: "@cs/ui-shell",
      setColorScheme: (scheme) => ctx.theme.setTheme(scheme),
      hooks: { theme },
    }),
  }, BuildProbe));
```

- React 컴포넌트의 props 타입은 `PropsRuntime<"슬롯 이름">`(부모가 주는 값과 틀의 훅)과 `InjectFace<등록이 돌려주는 타입>`(`hooks` 칸이 `use<이름>` 훅으로 바뀐 모양)의 교차다. `hooks` 자체는 props로 오지 않는다(타입에서도 빠진다).
- `hooks`에 넣는 값은 `getSnapshot`이 다음 변경까지 **같은 참조**를 돌려줘야 한다(업스트림 규칙: "Keep observable source and snapshot identities stable between changes"). 서비스의 "스냅샷 읽기 + 변경 이벤트" 쌍이 그대로 맞는다.
- 목록(`list`) 슬롯에 등록할 때는 `id`가 필수다. 빠지면 타입 오류다.
- 이 시험용 등록은 3-0에서 셸의 등록으로 바뀐다.

이 프로젝트에 관계있는 슬롯(이름, 종류/범위):

| 영역           | 슬롯                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 틀             | `main`(keyed/root), `main.conversation`(single/session-maybe), `shell.overlay`(list/root), `shell.leading`(single/root), `shell.bottom`(single/root)                                                                                                                                                                     |
| 왼쪽 사이드바  | `sidebar`(single/root), `sidebar.brand.name`·`sidebar.brand.mark`(single/root), `sidebar.workspaces`(single), `sidebar.panellist`(list/root), `sidebar.settings`(single/root), `sidebar.footer.action`(list/root)                                                                                                        |
| 우측 패널      | `sidebar.right.pane.tab`(keyed), `sidebar.right.pane.tab.title`(keyed), `sidebar.right.tab.menu.item`(list/session)                                                                                                                                                                                                      |
| 대화           | `conversation.session`(single/session), `conversation.view`(list/session), `conversation.header`(single/session-maybe), `conversation.composer`(chain/session), `conversation.input.left`·`.right`·`.dock`·`.overlay`(list/session), `conversation.hero.*`                                                               |
| 채팅 본문      | `conversation.chat.node`(keyed), `conversation.chat.turnTail`(list/session), `conversation.chat.markdown.fence`(hoc/session), `conversation.chat.assistant-actions`(list/session), `tool.call.toolview`(keyed), `tool.call.images`(single/session)                                                                       |
| 설정           | `settings.section`(list/root), `settings.general.item`(list/root), `settings.models.provider-card`(keyed/root), `settings.action`(list/root)                                                                                                                                                                             |

## 화면 교체

DreamVerse의 `@dv/ui-shell`이 쓰는 장치다. 아래 표의 방법은 기본 dsh 0.2.2-rc.5 위에서 **띄워 확인**했다. 확인한 것은 장치(슬롯 교체, 우측 탭, 채팅 재배치, 프로젝트 만들고 열기)가 동작한다는 것이고, 그 시험 코드는 위의 주의대로 규칙을 따르지 않은 형태였다.

| 하려는 것                            | 방법                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 가운데를 우리 화면으로               | `main.conversation`에 `priority: -1`                                                                                       |
| 왼쪽의 작업공간 목록을 우리 목록으로 | `sidebar.workspaces`에 `priority: -1`                                                                                      |
| 왼쪽 사이드바 전체를 교체            | `sidebar`에 `priority: -1`(DreamVerse는 이것을 쓰지 않고 일부를 CSS로 숨겼다)                                              |
| 브랜드 이름과 마크                   | `sidebar.brand.name`·`sidebar.brand.mark`에 `priority: -1`(마크를 없애려면 `null`을 그리는 React 컴포넌트)                 |
| 우측 패널에 탭 추가                  | `ctx.sidebarRightTabs.register(정의)` + `sidebar.right.pane.tab`에 `key: 정의의 id`로 본문 등록                            |
| 우측 탭 열기                         | `ctx.sidebarRight.openTab(kind)`                                                                                           |
| 채팅을 우측 탭으로                   | 탭 본문에서 Factory 슬롯 `conversation.content`를 그린다(아래)                                                             |
| 프로젝트 만들고 열기                 | `ctx.workspaces.create({ path })` → `ctx.sessions.create({ workspaceId })` → `ctx.uiWorkspace.openSession(sessionId)`      |
| 사이드바에 패널 아이콘 추가          | `sidebar.panellist`에 `{ id, order, label }` + `main`에 `key: 같은 id`(덧붙이기형. 지금 방향에서는 쓰지 않는다)            |

- `ctx.workspaces.create`의 `path`는 폴더의 절대 경로다. 시험에서는 시험이 준비한 폴더를 넘겼다. DreamVerse는 화면용 API(`/api/dv/projects/untitled`)에 새 폴더 경로를 물어 받고, 그 API는 "DreamVerse 폴더" 안에 빈 폴더를 만든다. 그 폴더의 위치는 dsh의 `defaultWorkspaceDirectory`(시스템의 문서 폴더를 기준으로 기본 작업공간 위치를 정한다)로 얻는다(**소스 확인(DreamVerse)**). 우리 쪽 위치는 2-0에서 정한다.
- 세션을 만들 때 어느 에이전트 프리셋을 쓸지 줄 수 있다(`ctx.sessions.create`의 `agentPreset`, **소스 확인**).
- DreamVerse 셸에는 프로젝트 안에서 세션을 바꾸는 부품이 있다(`packages/dv/ui-shell/src/client/SessionSwitcher.tsx`, 읽지 않았다). 프로젝트 하나에 세션을 몇 개 둘지는 3-0에서 정한다.

### 채팅을 우측 탭으로 옮기는 코드

```js
const CHAT_ID = '@cs/ui-shell/chat'

// 대화의 여러 뷰 중 채팅만 그린다.
function ChatOnlyView(props) { return props.renderSlot('conversation.session', { view: 'chat' }) }

function ChatTab({ renderFactorySlot }) {
  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    renderFactorySlot('conversation.content',
      { variant: 'embedded', phase: 'active', hero: false },
      { slots: { views: ChatOnlyView } }))
}

ctx.effect(() => ctx.sidebarRightTabs.register({
  id: CHAT_ID, kind: 'cs-chat', priority: 'builtin', keepMounted: true, title: () => 'Chat',
  guide: [{ id: 'cs-chat', order: 30, title: () => 'Chat', description: () => 'Talk with the agent' }],
}))
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: CHAT_ID }, ChatTab)))
```

- 이 코드로 우측 탭에 채팅 화면과 입력창이 그려지고 글이 쳐지는 것까지 **띄워 확인**했다. 메시지를 보내고 받는 것은 모델 키가 없어 확인하지 못했다(1-3).
- `conversation.content`의 속성: `variant`는 `'main'` 또는 `'embedded'`, `phase`는 `'settling'`·`'hero'`·`'active'`, `hero`는 불리언, 지역 슬롯은 `views`와 `widthControls`다. 업스트림의 `ui-subagent/sidebar-chat`도 같은 Factory 슬롯을 쓴다(**소스 확인**).
- `renderFactorySlot`에 넘기는 지역 React 컴포넌트는 모듈 최상위 함수여야 한다. 렌더 중에 만들면 매번 다시 마운트된다(**소스 확인**).
- 탭 정의의 필드(**소스 확인**): `id`, `kind`, `multiple?`, `keepMounted?`, `patterns?`, `priority?`, `canOpen?`, `title(address)`, `guide?`.
- 가운데 React 컴포넌트는 슬롯 props로 `sessionId`, `useSessions(selector)`, `useWorkspaces(selector)`를 받는다. 예: `props.useSessions(s => s.byId[props.sessionId]?.title)`, `props.useWorkspaces(s => s.items.length)`.
- **같은 세션의 대화 본문을 두 곳에 그리지 않는다.** dsh는 세션마다 입력 편집기를 하나 두고 마지막에 마운트된 입력창에 묶으며, 입력창이 내려가면 연결을 푼다. 그래서 두 곳에 그렸다가 한쪽을 내리면 남은 쪽은 글자는 쳐지지만 전송이 안 된다(**소스 확인(DreamVerse)**: `packages/dv/ui-shell/src/client/tabs.tsx`의 주석. 0.2.2-rc.5에서 재현해 보지는 않았다). 가운데에서 대화를 빼고 우측 탭에만 둔다.

## 그릴 재료

### 기본 부품

`@deepseek-ai/dsh-client-ui-primitives`(공유 모듈). 브라우저 절반에서 값으로 가져와 쓸 수 있다(**띄워 확인**: `Button`, `Input`, `SegmentedControl`, `Tag`).

- 입력·동작: `Button`(`variant`: primary, ghost, outline, toolbar. `size`: md, sm. `icon`), `Input`, `Checkbox`, `Switch`, `SegmentedControl`(`id`, `value`, `options`, `onChange`, `label`), `SegmentedTabs`, `InlineEditor`
- 겹침: `Modal`, `Menu`·`MenuGroup`·`MenuItemButton`·`MenuSurface`, `Tooltip`, `HoverCard`, `Toast`, `ImageLightbox`
- 표시: `Tag`, `Pill`, `StateDot`, `TextShimmer`, `ShortcutKeys`, `PathLabel`, `FileTypeIcon`, `ConnectionIndicator`, 아이콘 모음
- 에이전트 출력: `MarkdownText`, `CodeBlock`, `DiffBlock`, `TerminalBlock`, `JsonBlock`·`JsonTree`, `ReadBlock`, `SearchBlock`, `WebBlock`
- 설정: `SettingsForm`, `SettingsValueField`, `SettingsSecretField`
- 훅: `useClipboardCopy`, `useModalLayer`, `useDismissOnOutsidePointer`, `useAnchoredMaxHeight` 등

**없는 것**: 표, 슬라이더, 셀렉트·콤보박스, 트리, 카드, 일반 여러 줄 입력(`InlineEditor`는 textarea지만 자동 포커스·Enter 저장·최대 여섯 줄인 짧은 초안용이다). 직접 만든다(3-1). 부품 목록은 업스트림 `packages/client/ui-primitives/README.md`의 "component catalog"가 기준이다.

### 색과 테마

- 색은 `--dsw-alias-*` 토큰으로 쓴다(**띄워 확인**: 라이트·다크가 따로 손대지 않아도 바뀐다). 자주 쓰는 것: `label-primary`·`-secondary`·`-tertiary`, `bg-base`, `bg-layer-1`·`-2`·`-3`, `border-l1`~`-l4`, `interactive-bg-hover`·`-active`, `state-error-primary`·`state-success-primary`·`state-warn-primary`, `brand-primary`, `link`. 토큰 값의 출처는 업스트림 `packages/client/ui-theme/src/styles/`다.
- 테마 상태는 `document.documentElement`의 `color-scheme` 스타일과 `data-ds-theme-source`, `<body>`의 `data-ds-dark-theme`(다크일 때만 빈 값으로 있고 라이트에서는 없다), `<body>` 인라인의 `--dsw-*`·`--dsh-*` 토큰에 있다. 바꾸고 읽는 것은 `ctx.theme.setTheme(id)`·`ctx.theme.getTheme()`이다.
- `ctx.theme.getTheme()`은 스냅샷(`preference`, `active.colorScheme`, `themes`, `revision` 등)을 돌려주고 다음 변경까지 같은 객체다. 바뀌면 `theme/change` 이벤트가 새 스냅샷과 함께 온다. `setTheme`은 `"light"`, `"dark"`, `"system"`과 등록된 테마 id를 받고, 모르는 id에는 던진다(**띄워 확인**: `setTheme("light" | "dark")`와 `active.colorScheme`, 2026-11-26. 나머지는 **소스 확인**).
- dsh의 전역 규칙이 우리 요소에도 적용된다: `*, ::before, ::after { corner-shape: var(--dsw-corner-shape) }`(모서리가 superellipse가 된다)와 `:focus-visible`의 외곽선 색·두께. 모양을 dsh에 맞추는 데는 도움이 된다.
- 우리 CSS는 우리 클래스에만 건다. 맨 요소 선택자와 전역 리셋을 넣지 않는다. dsh의 CSS는 전부 레이어 밖에 있어서 `@layer` 안의 규칙보다 항상 우선한다.
- 업스트림의 스타일 규칙은 `docs/web-styling.md`와 `docs/ui-radius.md`다. 저장소 안 패키지는 CSS Modules + `clsx`를 쓰고 컴포넌트 라이브러리와 Tailwind를 금한다.

### 언어

dsh가 싣고 오는 언어는 영어, 중국어, 일본어, 스페인어, 프랑스어, 독일어, 러시아어, 브라질 포르투갈어다. **한국어는 없다.** 플러그인은 `ctx.locale.register`로 자기 사전을 등록하고(타입이 있는 객체 형태는 `zh`와 `en`이 필수), 외부 언어 팩도 등록할 수 있다(**소스 확인**: `packages/client/locale/README.md`). 한국어 언어 팩을 만들지, 우리 문자열을 사전으로 옮길지는 1-6에서 정한다. 그때까지는 `AGENTS.md`의 임시 규칙을 따른다(한국어 문자열을 패키지마다 한 모듈에 모은다).

## 브라우저 쪽 서비스

`inject`에 이름을 적으면 `ctx`에서 쓴다. 아래는 시험에서 실제로 부른 것이다(**띄워 확인**). 타입이 어느 패키지에 있는지는 "타입을 얻는 패키지"에 있다.

| 서비스                 | 쓴 것                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ctx.slots`            | `inject`, `register`                                                                                               |
| `ctx.sidebarRightTabs` | `register(정의)`                                                                                                   |
| `ctx.sidebarRight`     | `openTab(kind)`, `isExpanded()`, `mounted`(구독 가능한 값)                                                         |
| `ctx.workspaces`       | `list`(구독 가능. 스냅샷의 `items[]`에 `workspaceId`, `title`, `sessionIds`), `create({ path })`                   |
| `ctx.sessions`         | `create({ workspaceId })` — 세션 id를 돌려준다. 옵션은 `workspaceId?`, `cwd?`, `sessionId?`, `agentPreset?`        |
| `ctx.uiWorkspace`      | `openSession(id)`. 그 밖에 `openWorkspace`, `forkSession`, `connectWorkspace`, `startSession`, `archiveSession`    |
| `ctx.theme`            | `setTheme(id)`, `getTheme()`                                                                                       |
| `ctx.layout`           | 이름만 주입해 봤다                                                                                                 |

## 호스트 쪽

DreamVerse의 서버 쪽 패키지가 dsh에서 가져다 쓰는 것이다. 전부 0.2.2-rc.5에 있고 타입이 맞는다(타입 검사로 확인, 차이 5건은 `docs/DREAMVERSE.md`). 실행해 보지는 않았다. 쓰는 법은 업스트림 문서를 본다.

| 하려는 것                       | dsh 패키지와 이름                                                                                                   | 업스트림 문서                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 플러그인·서비스 만들기          | `@deepseek-ai/cordis`(`Context`, `Service`), `@deepseek-ai/schemastery`(설정 스키마)                                | `docs/cordis-tutorial/`, `docs/cordis-primer.md`           |
| 에이전트 도구 등록              | `@deepseek-ai/dsh-tools`(`defineTool`, `ToolDefinition`, `ToolRunContext`, `validateArgs`), 서비스 `ctx.tools`      | `docs/cookbook/adding-a-tool.md`, `docs/subsystems/tools.md` |
| 턴이 시작되기 전에 끼어들기     | `@deepseek-ai/dsh-agent`(이벤트 `agent/pre-step`, `PreStepDecision`)                                                | `docs/agent-lifecycle.md`                                  |
| 세션 이벤트 듣기, 세션별 상태   | `@deepseek-ai/dsh-session`(이벤트 `session/event`), `dsh-session-projection`(`ctx.sessionProjections`)              | `docs/subsystems/session.md`, `session-projection.md`      |
| 모델에게 보낼 메시지 만들기     | `@deepseek-ai/dsh-llm`(`createUserMessage`, `ContentBlock`)                                                         | —                                                          |
| 시스템 프롬프트에 절 추가       | `@deepseek-ai/dsh-system-prompt`                                                                                    | `docs/subsystems/system-prompt.md`                         |
| 스킬 등록                       | `@deepseek-ai/dsh-skill`                                                                                            | `docs/subsystems/skills.md`                                |
| 작업공간 읽기                   | `@deepseek-ai/dsh-workspace`(`ctx.workspaceRegistry`)                                                               | `docs/subsystems/workspace.md`                             |
| 브라우저가 부를 HTTP 라우트     | `@deepseek-ai/dsh-client-connection`(`ConnectionFetchRoute`), `@deepseek-ai/dsh-host-webserver`(`ctx.webServer.register`) | `docs/cookbook/adding-a-remote-api.md`, `docs/subsystems/web-server.md` |
| 비밀값                          | `ctx.credentials` — 설정에는 참조(환경 변수 이름 모양)만 두고 쓸 때마다 `resolve(ref)`로 읽는다                     | `docs/subsystems/credentials.md`                           |
| 세션 로그가 아닌 데이터 저장    | `ctx.storage`, `ctx.storageDomain` — zod 스키마로 도메인을 선언하고 연다                                            | `docs/subsystems/storage.md`                               |
| 설정 화면에 카드 추가           | —                                                                                                                   | `docs/cookbook/adding-a-settings-card.md`                  |

## 에이전트 프리셋

dsh 웹(`dsh-web-app` 번들)에서 에이전트가 가질 도구·스킬·페르소나는 **에이전트 프리셋**이 정한다. 에이전트가 프로젝트 폴더를 기록 밖에서 고칠 수 있는지가 여기서 갈리므로(`AGENTS.md` "꼭 지킬 것") 따로 적는다.

- 프리셋 하나는 `@deepseek-ai/dsh-agent-preset` 행이다. `config`는 `id`, `plugins`(에이전트에 붙일 플러그인 행 목록), `name?`, `description?`, `order?`다. `agent-preset-registry` 행의 `config.default`가 기본 프리셋의 id다(**소스 확인**: 업스트림 `packages/preset/agent-preset/README.md`, `agent-preset-registry/README.md`).
- 기본 제공 프리셋은 `standard`(기본값), `ptc`, `minimal`, `cordis` 넷이고 `dsh-web-app` 번들의 `presets/*.patch.yml`에 있다. 우리 프로필의 합성 구성에도 이 행들이 있다(`--dump-config`로 확인, 2026-11-25).
- **`standard`의 에이전트는 셸과 파일 도구를 가진다.** 싣는 플러그인(**소스 확인**): `persona`, `agent-instructions`, `time-context`, `tool-bash`, `tool-pwsh`, `tool-fs`, `tool-fs-search`, `tool-jobs`, `tool-schedule`, `skill-filesystem`, `tool-skill`, `command-goal`, `tool-goal`, `tool-ask-user`, `tool-todo`, `tool-web`, `tool-present`, `tool-office`, 플러그인 관리 도구 둘, 그리고 planning·compaction·delegation 묶음. `minimal`은 `persona`, `tool-fs`, compaction, persistent-shell이다.
- 새 프리셋이나 기본 제공 프리셋의 덮어쓰기는 번들 패치로 한다: `@deepseek-ai/dsh-agent-preset` 행을 `insert`하거나, 그 행의 `id`로 패치한다(**소스 확인**).
- 사용자가 설정 화면에서 고른 기본 프리셋(`selectedDefault`)이 `config.default`보다 우선한다(**소스 확인**). 그래서 우리 프리셋을 기본으로 두는 것만으로는 사용자가 `standard`로 바꾸는 것을 막지 못한다.
- 세션을 만들 때 프리셋을 줄 수 있다(`ctx.sessions.create({ agentPreset })`, **소스 확인**).
- **DreamVerse가 한 것**(**소스 확인(DreamVerse)**): 자기 프리셋 `dreamverse`를 기본으로 두고 그 안에 `persona`, `skill-filesystem`(자기 스킬 폴더만), `tool-skill`, `tool-ask-user`, compaction 묶음만 넣었다. 셸·파일 도구가 없다. 연산 도구(`dv_*`)는 프리셋 안이 아니라 `@dv/project`가 `tools` 서비스에 등록한다(`ctx.inject(['tools'], …)`). 레지스트리에는 `modeSelectionEnabled: false`를 준다(이름으로 보아 프리셋 고르기를 끄는 설정이다. 동작은 읽지 않았다). 이 필드는 0.2.2-rc.5의 레지스트리에서 빠졌다(업스트림 문서가 "retired"라고 적는다).
- 확인하지 못한 것: 0.2.2-rc.5에서 우리 프리셋을 넣어 띄우는 것, 프리셋 밖에서 `tools` 서비스에 등록한 도구가 그 프리셋의 에이전트에게 보이는지(2-0), 기본 제공 프리셋 행을 끄거나 덮었을 때의 동작.
- **에이전트에게 무엇을 줄지는 정해지지 않았다**(`docs/DECISIONS.md` "미정", 1-4).

## dsh가 이미 주는 기능

패키지와 문서로 확인했다(**소스 확인**). 직접 써 보지는 않았다.

| 기능              | 내용                                                                                                                                                                              | 문서                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| LLM 프로바이더    | 설정 → Models. DeepSeek, 내장 목록(`anthropic`, `openai`, `moonshotai`, `zai` …), 사용자 지정 API(네 가지 프로토콜). 키는 쓰기 전용이고 `$DSH_HOME/.credentials.yaml`에 저장된다. | `docs/user/guide/providers.md`          |
| 예약 실행         | 모델이 `schedule_create` 등으로 만들거나 Automation tasks 화면에서 만든다. 반복 규칙은 RFC 5545다.                                                                                | `docs/user/guide/schedule.md`           |
| MCP               | stdio 또는 Streamable HTTP 서버를 붙이면 도구가 `mcp__<서버>__<도구>`로 보인다.                                                                                                   | `docs/subsystems/mcp.md`                |
| 스킬              | `skill`, `skill-filesystem`, `tool-skill` 행                                                                                                                                      | `docs/subsystems/skills.md`             |
| 서브에이전트      | `subagent`, `tool-subagent` 행, 에이전트 프리셋                                                                                                                                   | `docs/subsystems/subagent.md`           |
| 웹 검색           | `web-search-deepseek` 행. DeepSeek 외의 모델에서 되는지는 미확인                                                                                                                  | —                                       |
| 기억              | 서드파티 MCP 기억 서버 세 가지의 예시 구성만 있다(기본 꺼짐)                                                                                                                      | `docs/user/guide/mcp-memory.md`         |
| 원격 접속         | 리버스 프록시 + `--public-url`·`--trusted-host`. 로그인은 토큰 주소 + 세션 쿠키                                                                                                   | `docs/user/guide/public-deployments.md` |

예약 도구(`tool-schedule`)와 웹 도구(`tool-web`)는 `standard` 프리셋의 플러그인이다. 우리 프리셋에 무엇을 넣는지에 따라 에이전트가 쓸 수 있는 기능이 달라진다("에이전트 프리셋").

## 포크에서만 되는 것

DreamVerse가 dsh 코어에 넣은 패치로만 되는 기능이다. 업스트림 0.2.2-rc.5와 0.2.3-alpha.2 어디에도 없다. **기대지 않는다.** 필요해지면 멈추고 사용자에게 알린다.

- `conversation.chat.markdown` 체인 — 채팅 Markdown의 링크·이미지·표를 다른 React 컴포넌트로 그리기. 업스트림에는 코드 펜스용 `conversation.chat.markdown.fence`만 있다.
- `conversation.input.reference` 슬롯, 프롬프트 편집기 Factory 슬롯, `inputTriggers.controllerFor` — 입력창 참조 칩의 모양과, 채팅 밖에서 쓰는 같은 프롬프트 입력기.
- `conversation/before-send` 이벤트 — 전송 직전에 끼어들기(DreamVerse는 첫 메시지에서 프로젝트를 자동으로 만든다).
- 그 밖: `sidebarRight.expanded` 구독, `conversation.session`의 `focus` 속성, 도구 표시 이름 사전, `@deepseek-ai/dsh-mcp-servers` 패키지.

DreamVerse 화면 패키지 중 셋은 0.2.2-rc.5에 없는 이름을 써서 그대로 가져올 수 없다(이름 대조, 2026-11-25): `@dv/ui-composer`(`PromptChip`, `PromptContent`, `PromptChangeCause`, `PromptHostModel`, `ReferenceFaceOwner`, `MarkdownElement`, `MarkdownTableElement` 일곱 개), `@dv/ui-text-node`(`PromptContent`, `PromptHostModel` 등), `@dv/ui-mcp-presets`(`@deepseek-ai/dsh-mcp-servers`).

## dsh 내부에 기대는 장치

슬롯이 없는 것을 건드리는 방법이다. 동작은 하지만 dsh의 공개 계약이 아니라서 버전을 올리면 깨질 수 있다. **한 파일에 모으고 주석으로 표시한다.**

| 장치                       | 예                                                                                                                  | 확인                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| CSS 클래스 접미사로 숨기기 | `button[class$="_newSession"] { display: none !important; }`(CSS Modules의 해시 앞 이름에 건다)                     | 띄워 확인(0.2.2-rc.5에서 맞는다)      |
| 서비스 함수 덮어쓰기       | DreamVerse는 `ctx.uiWorkspace.startSession`과 `ctx.workspaces.initializeDefault`를 `Object.defineProperty`로 바꾼다 | 소스 확인(DreamVerse)                 |
| 사전 문자열 바꾸기         | DreamVerse는 로케일 사전을 직접 고쳐 문구를 바꾼다                                                                  | 소스 확인(DreamVerse)                 |
| 명령 목록 가리기           | DreamVerse는 `commandUi.directory.fetchCommands`를 바꾼다                                                           | 소스 확인(DreamVerse)                 |

DreamVerse가 CSS로 숨기거나 막는 기본 요소(`packages/dv/ui-shell/src/client/chrome.tsx`, **소스 확인(DreamVerse)**). 3-0에서 숨길 목록을 정할 때의 출발점이다. 아래는 추린 것이고, 선택자가 0.2.2-rc.5에서 맞는지는 첫 줄만 확인했다.

```css
button[class$="_newSession"] { display: none !important; }                                   /* 새 세션 버튼 */
nav[class$="_panelList"]:has(span[class*="_panelTitle"]) { display: none !important; }     /* 펼친 사이드바의 패널 목록 */
button[class*="_brand "] { pointer-events: none; cursor: default; }                         /* 브랜드를 눌러 새 세션 열기 */
button[aria-label$=" of context used"] { display: none !important; }                        /* 입력창의 컨텍스트 사용량 */
[data-trigger-menu] span[class$="_itemAlias"] { display: none !important; }                 /* 명령 메뉴의 별칭 */
span[class$="_brandMark"]:has(> [data-slot="sidebar.brand.mark"]:empty) { display: none !important; }  /* 빈 브랜드 마크 */
```

## 함정

- 새 프로필을 처음 열면 "Preview Notice" 창(버튼은 `Continue`)과 "Get started" 창(API 키·로그인, `Close`로 닫는다)이 차례로 뜬다. 첫 창이 떠 있는 동안 페이지 전체가 inert라 클릭이 막힌다.
- Preview Notice 창은 페이지 로드가 끝난(`networkidle`) 뒤에 뜬다. 로드 직후에 `count()`로 있는지 보면 0이 나와 닫지 못하고 지나간다(2026-11-26에 그렇게 됐다). 창이 뜨기를 기다린 뒤 닫는다.
- pnpm 10은 의존성의 설치 스크립트를 돌리지 않는다. dsh를 설치하면 `@deepseek-ai/dsh-subprocess-local`(`node-pty`의 `spawn-helper`에 실행 권한을 준다), `node-pty`, `koffi`, `protobufjs`, `@google/genai` 다섯 개가 무시됐다고 나온다. 그 상태로 웹은 뜬다(**띄워 확인**, 2026-11-26). 에이전트의 셸 도구가 그 상태로 도는지는 보지 않았다(1-3, 1-4). 필요하면 `pnpm-workspace.yaml`의 `onlyBuiltDependencies`에 적어 돌리게 한다.
- "Get started" 창의 DOM 노드를 강제로 지우면 `sidebar.settings` 슬롯이 `removeChild` 오류로 죽는다. 반드시 버튼으로 닫는다.
- Preview Notice를 넘기면 프로필 `cordis.patch.yml`의 `ui-settings-general` 행에 `welcomeNoticeVersion`이 기록된다(관찰).
- 실행 때 출력되는 주소에는 로그인 토큰이 들어 있다. 로그나 문서에 붙이지 않는다.
- `--from-default-profile`은 있던 프로필을 덮어쓴다. 설정 화면에서 바꾼 값이 사라진다.
- 브라우저 절반을 고치고 빌드하지 않으면 옛 `lib/client.js`(브라우저 번들)가 나간다. `pnpm dsh:start`는 띄우기 전에 빌드하지만, 띄워 둔 동안 고친 것은 `pnpm build`를 다시 돌려야 나간다.
- **dsh를 띄워 둔 채 `lib/client.js`가 바뀌면 새로고침 없이 화면이 새 번들로 바뀐다**(**띄워 확인**, 2026-11-26. 파일을 바꾸고 1.5초 뒤에 이미 바뀌어 있었고 콘솔 오류는 없었다). 개발할 때는 dsh를 띄워 두고 `pnpm build`만 다시 돌리면 된다. 호스트 절반을 고친 것이 다시 실리는지는 보지 않았다.
- `verbatimModuleSyntax` 아래에서 `import { type X } from "…"`는 값 import로 남는다. 표 밖의 `@deepseek-ai/*`면 빌드가 거절한다. `import type { X } from "…"`로 쓴다.
- 임시 home으로 처음 띄우면 "Unable to create default workspace. Use Choose workspace to select a folder." 토스트가 뜬다(관찰, 2026-11-26. 콘솔 오류는 아니다. 원인은 보지 않았다. 기본 작업공간은 3-0과 2-0이 다룬다).
- 헤드리스 확인 환경에 한국어 글꼴이 없으면 스크린샷의 한국어가 네모로 나온다. DOM의 글자로 확인한다.
- 프로필의 번들 링크는 절대 경로다. 저장소 폴더를 옮기거나 다른 워크트리에서 띄우려면 링크를 다시 건다("워크트리와 DSH_HOME").
- Playwright는 크기가 0인 요소를 "숨김"으로 본다. 표시용 빈 요소를 기다릴 때는 `state: 'attached'`를 쓴다.
- 토스트 같은 알림은 화면에 안 보이는 `aria-live` 사본이 따로 있다. 시험에서 보이는 요소만 골라야 한다.
- `$DSH_HOME/.credentials.yaml`은 프로필을 만들 때 자동으로 생기고 브라우저 세션용 비밀값이 들어 있다. 커밋하지 않는다.

## 띄워서 확인하는 법

화면이 걸린 변경은 dsh를 실제로 띄워 확인한다. 아래는 2026-11-24~25에 쓴 절차를 한 파일로 정리한 것이다(`playwright-core` 1.65.1). 이 모양 그대로 돌려 보지는 않았다. 1-2에서 조합 시험으로 만든다.

1-0과 1-1에서는 저장소 밖에 둔 같은 모양의 스크립트로 `DSH_HOME=<임시 폴더> pnpm -s dsh:start --no-open --port 0`을 띄워 화면과 콘솔 오류 0건을 확인했다(2026-11-26). 1-1의 스크립트는 두 창이 뜨기를 기다렸다가 닫고(`waitFor({ state: "visible" })`), 시험용 요소의 속성과 계산된 스타일을 읽고, 버튼을 눌러 테마가 바뀌는지 봤다. 아래 0번의 두 명령은 `DSH_HOME=<임시 폴더> pnpm dsh:profile` 하나로 바꿀 수 있다. 3번의 창 닫기는 아래처럼 쓰면 Preview Notice를 놓친다("함정"). `playwright-core`는 아직 이 저장소의 의존성이 아니다.

**브라우저 준비.** 그때는 이 장비에 받아 둔 Chromium을 경로로 지정해 썼다(`~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`). 다른 장비에서는 `CHROME`에 Chrome이나 Chromium 실행 파일 경로를 주거나, `pnpm exec playwright-core install chromium`으로 받고 `executablePath`를 빼서 playwright가 찾게 한다(이 설치 명령은 이 저장소에서 돌려 보지 않았다).

```js
import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 0. 시험용 home을 임시 폴더에 만든다. 개발용 home의 설정과 키를 건드리지 않는다.
const env = { ...process.env, DSH_HOME: await mkdtemp(join(tmpdir(), 'cs-dsh-')) }
const dsh = (...args) => execFileSync('pnpm', ['exec', 'dsh', ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] })
dsh('--profile', 'comfy-studio', '--from-default-profile', 'web', '--dump-config')
dsh('plugin', '--profile', 'comfy-studio', 'add', resolve('packages/bundle'))

// 1. dsh를 빈 포트에 띄우고 출력에서 토큰 주소를 읽는다. 이 주소는 로그에 남기지 않는다.
const child = spawn('pnpm', ['exec', 'dsh', '--profile', 'comfy-studio', '--no-open', '--port', '0'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
const url = await new Promise((resolveUrl, reject) => {
  const onData = (chunk) => { log += chunk; const m = /dsh web: (http\S+)/.exec(log); if (m) resolveUrl(m[1]) }
  child.stdout.on('data', onData); child.stderr.on('data', onData)
  child.on('exit', code => reject(new Error(`dsh exited with ${code}`)))
})

// 2. 페이지를 열고 콘솔 오류를 모은다.
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const issues = []
page.on('console', m => { if (['error', 'warning'].includes(m.type())) issues.push(m.text()) })
page.on('pageerror', e => issues.push(String(e)))
await page.goto(url, { waitUntil: 'networkidle' })

// 3. 첫 실행 창을 버튼으로 닫는다.
const notice = page.locator('[role="dialog"]', { hasText: 'Preview Notice' }).getByRole('button', { name: 'Continue' })
if (await notice.count()) await notice.first().click()
const close = page.locator('[role="dialog"]', { hasText: 'Get started' }).getByRole('button', { name: 'Close' })
if (await close.count()) await close.first().click()

// 4. 확인하고 정리한다. issues가 비어 있어야 한다.
await browser.close(); child.kill('SIGTERM')
```

- 끝나면 dsh와 브라우저 프로세스가 남지 않았는지 확인하고 임시 home을 지운다.
- 호스트 쪽 서비스를 화면 없이 확인하는 방법은 정해지지 않았다. 1-2에서 정한다(`docs/ROADMAP.md` 1-2).
- 살아 있는 슬롯 트리는 dsh의 `cordis_inspect what:"client"`로 물어볼 수 있다고 업스트림 문서에 있다(미확인).

## 버전 올리기

1. 업스트림 `docs/upgrade-guide/v<버전>/`을 읽는다. 플러그인 작성자에게 깨지는 변경이 있는 버전에만 있다(0.2.2-rc.5의 안내는 그 태그에 없다). 지금 버전과 올릴 버전 사이의 것을 전부 본다.
2. `@deepseek-ai/dsh`와 `@deepseek-ai/dsh-*`를 전부 같은 버전으로 올리고, `@deepseek-ai/cordis`·`@deepseek-ai/schemastery`는 그 버전이 끌고 오는 것으로 맞춘다. 번들의 `engines.dsh` 범위를 고친다.
3. 타입 검사와 단위 테스트를 돌린다.
4. "dsh 내부에 기대는 장치"의 항목을 하나씩 다시 확인한다. 클래스 접미사 선택자가 여전히 맞는지가 첫째다.
5. "에이전트 프리셋"을 다시 확인한다. 기본 제공 프리셋의 구성과 레지스트리의 설정이 바뀌었는지 본다.
6. 띄워서 셸과 채팅을 확인한다.
7. 이 문서의 버전 표기와 확인 날짜를 고친다.

2026-11-24에 본 업스트림 HEAD(0.2.3-alpha.2)도 React `^18.2.0`이었고 React 19로 옮긴다는 언급은 없었다.

## 업스트림에서 읽을 문서

모두 태그 `dsh-v0.2.2-rc.5` 기준 경로다.

| 문서                                                                         | 내용                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `docs/architecture.md`, `docs/glossary.md`                                   | 전체 구조, 용어, "새 동작은 어디에 붙이나"                   |
| `docs/cordis-tutorial/`, `docs/cordis-primer.md`, `docs/cordis-api/`         | Cordis 플러그인·서비스·이벤트                                |
| `docs/user/develop/`                                                         | 플러그인 작성자용 안내(설정, 도구, 배포, 이벤트, 서비스)     |
| `docs/subsystems/slots.md`                                                   | 슬롯의 선언·종류·props·주입. 화면 작업 전에 반드시 읽는다    |
| `docs/subsystems/web-client.md`, `docs/subsystems/client-modules.md`         | 웹 클라이언트 계층, 브라우저 모듈 로더                       |
| `packages/client/AGENTS.md`                                                  | 브라우저 코드 규칙, 새 플러그인 패키지 점검표                |
| `packages/client/modules/README.md`                                          | `dsh.client` 선언, 공유 모듈, 빌드 요건, 패키지 이미지       |
| `packages/client/ui-primitives/README.md`                                    | 기본 부품 목록                                               |
| `docs/subsystems/sidebar-right.md`, `docs/subsystems/conversation.md`        | 우측 패널, 대화 화면의 슬롯 계층                             |
| `docs/web-styling.md`, `docs/ui-radius.md`                                   | 스타일 규칙, 모서리 반경                                     |
| `docs/subsystems/credentials.md`, `docs/subsystems/storage.md`, `docs/subsystems/settings.md` | 비밀값, 저장, 설정                          |
| `docs/subsystems/tools.md`, `docs/subsystems/skills.md`, `docs/tool-catalog.md` | 도구, 스킬, 기본 제공 도구 목록                           |
| `packages/preset/agent-preset/README.md`, `packages/preset/agent-preset-registry/README.md` | 에이전트 프리셋                               |
| `docs/testing.md`                                                            | 업스트림의 시험 방침(실제 조합 시험을 요구한다)              |
| `docs/upgrade-guide/`                                                        | 깨지는 변경이 있는 버전의 안내                               |

## 확인하지 못한 것

- **실제 모델과의 채팅.** 모델 키가 없어 메시지를 주고받지 못했다. 우측 탭의 채팅에 메시지·도구 호출이 그려지는지, 채팅 안의 카드 슬롯에 우리 React 컴포넌트가 그려지는지는 1-3과 3-4에서 본다.
- **슬롯 등록의 `store`·`locale` 칸.** `inject`(값, 콜백)와 `hooks`, TSX와 JSX 자동 런타임, dsh 타입으로 하는 타입 검사, 공유 모듈 열한 개만 external로 둔 빌드, Astryx가 전혀 없는 브라우저 번들은 1-1에서 확인했다(2026-11-26).
- 서드파티 패키지가 같이 실린 브라우저 번들, 공유 모듈의 하위 경로(`zod/v4` 등), 플러그인이 내려갈 때 로더가 우리 `<style>`을 지우는 것, 호스트 절반을 고쳤을 때 다시 실리는지.
- **에이전트 프리셋.** 우리 프리셋을 넣어 띄우는 것, 프리셋 밖에서 등록한 도구가 에이전트에게 보이는지, 기본 제공 프리셋을 끄는 것.
- 무시된 설치 스크립트(`node-pty` 등)가 에이전트의 셸 도구에 주는 영향("함정").
- DreamVerse의 서버 쪽 코드를 0.2.2-rc.5에서 실행하는 것(타입 검사까지만 했다. 2-0).
- 가운데에 입력창을 끼운 첫 화면, `@` 메뉴에 우리 항목 추가.
- `ctx.credentials`와 `ctx.storageDomain`을 저장소 밖 플러그인에서 쓰는 것.
- 한국어 언어 팩 등록.
- 리버스 프록시 배포, 예약·MCP·스킬·서브에이전트·웹 검색의 실제 동작.
- Chrome 이외의 브라우저.
