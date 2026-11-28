# 코드 규칙

코드를 쓰면서 정해진 규칙을 한곳에 모았다(1-7, 2026-11-28). 새 규칙을 만든 문서가 아니다. 줄마다 그 규칙이 정해진 곳이나 지키게 하는 장치(설정 파일, 빌드, 린트)를 괄호에 적었다. 이유와 배경은 그 문서에 있고, 여기에는 "어떻게 쓰는가"만 둔다.

- 반드시 지킬 것(하지 않는 것, 의존 방향, 비밀값, 공개 범위)은 `AGENTS.md` "꼭 지킬 것"에 있다. 이 문서는 그 아래에서 코드를 쓰는 모양이다.
- dsh가 왜 그렇게 요구하는지와 띄워 확인한 사실은 `docs/DSH.md`에 있다.
- 구조와 계약은 `docs/ARCHITECTURE.md`에 있다.

규칙이 새로 생기거나 바뀌면 이 문서를 같은 커밋에서 고친다. 코드와 이 문서가 어긋나면 어느 쪽이 맞는지 정하고 둘을 맞춘다.

## 일반

- **TypeScript 6.0.3.** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`를 켠다(`tsconfig.base.json`). 빌드 산출물은 내지 않는다(`noEmit`). 타입 검사는 `pnpm typecheck`다.
- **지울 수 있는 문법만 쓴다.** `enum`, 생성자 매개변수 속성, `namespace`를 쓰지 않는다. Node가 `.ts`를 그대로 실행하기 때문이다(호스트 절반, `scripts/`, `tests/`). 브라우저 절반도 같은 설정을 물려받는다.
- **상대 import에는 확장자를 붙인다**(`./actions.ts`, `./Brand.tsx`).
- **포맷은 Prettier**다: 세미콜론, 큰따옴표, 폭 100, 끝 쉼표(`.prettierrc`). Markdown은 대상이 아니다(표를 손으로 맞춘다).
- **린트는 oxlint**다: `correctness`와 `suspicious` 범주가 오류이고 타입 기반 규칙이 켜져 있다(`.oxlintrc.json`). 기다리지 않은 Promise, 좁히는 타입 단언, 객체를 문자열로 만드는 것이 걸린다.
  - 타입 단언(`as`)은 좁히기(타입 가드, zod, `instanceof`)로 바꾼다. 바꿀 수 없는 곳만 `// oxlint-disable-next-line <규칙> -- <왜 안전한지>`로 그 줄에서 끈다(2-0, 4-0에서 정했다). 린트 설정에 예외를 더하지 않는다.
  - 시험의 단언은 패키지의 `src/testing/support.ts`에 있는 도우미로 모은다(`defined`, `asError`, `standIn`). 시험 파일마다 `as`를 쓰지 않는다.
- **밖에서 온 데이터는 zod로 좁힌다**(서버 응답, 파일에서 읽은 JSON, 요청 본문). 플러그인의 설정 스키마만 schemastery로 쓴다(dsh가 그것을 읽는다).
- **식별자와 주석은 영어, 화면에 보이는 문자열은 한국어, LLM이 읽는 글(도구 설명, 프롬프트 절)은 영어**다.
- **주석.** 파일 머리에 그 모듈이 무엇을 하는지와 설계가 적힌 문서의 자리를 적는다. 내보내는 함수·타입·상수에는 JSDoc을 단다. 주석은 코드가 말하지 못하는 것(왜, 무엇에 기대는지, 언제 다시 볼지)을 적는다.
- **의존성.** 새 의존성은 꼭 필요할 때만 더한다. 버전은 `^` 없이 정확한 버전으로 적는다(1-0). `@deepseek-ai/dsh`와 `@deepseek-ai/dsh-*`는 `0.2.2-rc.5`, `@deepseek-ai/cordis`는 `4.1.0`, `@deepseek-ai/schemastery`는 `3.19.0`이다. npm의 `latest`가 옛 버전인 dsh 패키지가 있으므로 버전을 빼고 설치하지 않는다.
- **커밋 전 검사는 `pnpm check`** 하나다(빌드, 타입 검사, 린트, 포맷 검사, 단위 시험). 화면, 플러그인의 등록, 번들, 실행 스크립트, 시험 틀에 닿으면 `pnpm test:integration`도 돌린다(`AGENTS.md` "명령").

## 이름

접두사는 cs 계열이다(사용자가 정했다, 2026-11-27).

| 무엇                         | 모양                                         | 예                                                    |
| ---------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| 패키지와 디렉터리            | `@cs/<이름>`, `packages/<이름>`              | `@cs/project`, `packages/project`                     |
| 화면 패키지                  | `@cs/ui-<이름>`                              | `@cs/ui-shell`                                        |
| 번들의 행 id                 | `cs-<이름>`                                  | `cs-project`, `cs-ui-shell`                           |
| 호스트 서비스                | `ctx.cs<이름>`                               | `ctx.csProject`, `ctx.csCatalog`, `ctx.csApi`         |
| 에이전트 도구                | `cs_<…>`                                     | `cs_proj_create`, 연산 도구 `cs_<연산>`               |
| 화면용 API의 경로            | `/api/cs/…`, 이벤트 스트림 `/cs/events`      | `/api/cs/projects`                                    |
| 환경 변수                    | `CS_<…>`                                     | `CS_PROJECTS_FOLDER`                                  |
| 우리가 선언하는 슬롯         | `cs.<자리>.<이름>`                           | `cs.center.view`                                      |
| 슬롯 등록·탭의 id와 kind     | `cs-<이름>`, `cs.<…>`, `@cs/<패키지>/<이름>` | `cs-new-project`, `cs-chat`, `@cs/ui-shell/chat`      |
| 시험이 잡는 DOM 속성         | `data-cs-<이름>`                             | `data-cs-project="<id>"`, `data-cs-chat`              |
| CSS 클래스(빌드가 만든다)    | `cs-[hash]-[local]`                          | `cs-W6SYKq-name`                                      |
| 프로젝트 폴더 안의 기록 자리 | `.comfy-studio/`                             | `.comfy-studio/records.jsonl`                         |
| 프롬프트 절, 인용 주소       | `cs:<…>`                                     | `cs:project`, `cs:<종류>/<id>`                        |
| 시험용 임시 폴더             | `cs-dsh-test-<…>`                            | 전역 정리가 이 이름으로 찾는다                        |

파일 이름:

- React 컴포넌트는 `PascalCase.tsx`다. 스타일은 그것을 쓰는 모듈과 같은 이름의 `.module.css`다(`Brand.tsx`와 `Brand.module.css`, `chrome.ts`와 `chrome.module.css`).
- 그 밖의 모듈은 `kebab-case.ts`다(`record-store.ts`, `wire-operation.ts`).
- 단위 시험은 대상 옆의 `<대상>.test.ts`다.
- 패키지마다 정해진 이름의 모듈: 브라우저 절반의 화면 문자열 `strings.ts`, 모듈과 시험이 같이 쓰는 id 상수 `ids.ts`, 브라우저로 나가는 타입 `wire.ts`, 시험 보조 `src/testing/`.

제품 이름은 화면에서 ComfyStudio다. DreamVerse의 이름과 로고를 쓰지 않고, dsh는 이름에 "DSH"로 적는다(`AGENTS.md`).

## 디렉터리

```
packages/<이름>/     패키지 하나. 종류는 아래 표
scripts/             프로필 만들기·실행(dsh.ts, dsh-env.ts), 브라우저 번들 빌드(build-client.ts)
tests/harness/       조합 시험의 틀(dsh 띄우기, 브라우저, 가짜 LLM, 호스트 시나리오)
tests/integration/   조합 시험. fixtures/(시험용 플러그인), scenarios/(dsh 안에서 도는 모듈)
types/               저장소 공용 타입 선언(css-modules.d.ts)
docs/                문서. 끝난 단계의 계획은 docs/archive/
```

| 패키지 종류              | 예                                   | 모양                                                                                     |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| 번들                     | `@cs/bundle`                         | `cordis.patch.yml`과 `package.json`뿐이다. 행을 넣고, 넣는 패키지에 의존한다             |
| 호스트 플러그인          | `@cs/project`, `@cs/catalog`, `@cs/api` | 호스트 절반만 있다. 번들에 행이 있다                                                  |
| 화면 플러그인            | `@cs/ui-shell`                       | 브라우저 절반이 있다(`src/client/`). 호스트 절반 `src/index.ts`도 있어야 한다            |
| 라이브러리               | `@cs/comfy`                          | dsh에 의존하지 않는다. 플러그인이 아니라 번들에 행이 없다. 모듈마다 하위 경로로 내보낸다 |

패키지를 나누는 단위는 기능 컴포넌트 하나에 패키지 하나, 화면 하나에 패키지 하나다(`docs/ARCHITECTURE.md` "패키지 구성"). 패키지 사이의 의존은 한 방향이다(`AGENTS.md` "꼭 지킬 것").

## 플러그인 패키지 하나의 모양

```
package.json
tsconfig.json           호스트 프로그램: src/ 중 src/client/ 밖, Node 타입
tsconfig.client.json    브라우저 프로그램(브라우저 절반이 있을 때만). 루트의 tsconfig.client.base.json을 extends만 한다
src/index.ts            호스트 절반
src/<모듈>.ts, <모듈>.test.ts
src/testing/            시험 보조(다른 패키지의 시험도 쓴다)
src/client/             브라우저 절반(아래 "브라우저 절반")
lib/client.js           브라우저 번들. 빌드 결과이고 커밋하지 않는다
```

`package.json`:

- `"private": true`, `"type": "module"`, `"version": "0.0.1"`.
- `main`과 `exports["."]`는 `./src/index.ts`다. **호스트 절반은 빌드하지 않고 `.ts` 그대로 내보낸다**(1-1).
- 브라우저 절반이 있으면 `exports["./client"]`를 `./lib/client.js`로 두고 `dsh.client`를 적는다(`platform: "web"`, `inject`는 기대는 dsh 클라이언트 패키지 이름의 목록이고 정보용이다. 실행 순서는 진입점의 `inject`에 적은 서비스가 정한다). `dsh.client`가 있는데 `./client`가 없으면 dsh가 뜨지 않는다.
- 다른 패키지가 쓰는 얼굴은 하위 경로로 내보낸다: 타입만 든 진입점(`./types`, `./wire`), 시험 보조(`./testing/<이름>`). 내보내지 않은 파일을 다른 패키지에서 경로로 가져오지 않는다.
- `scripts.typecheck`는 호스트 프로그램을, 브라우저 절반이 있으면 브라우저 프로그램도 검사한다(`tsc -p tsconfig.json && tsc -p tsconfig.client.json`).
- 의존성의 자리(2-0에서 정했다):
  - 호스트 절반이 **값으로** 쓰는 dsh 패키지는 `dependencies`.
  - `@deepseek-ai/cordis`와 `@deepseek-ai/schemastery`는 `peerDependencies`와 `devDependencies`. dsh가 실은 것과 같은 모듈이어야 서비스가 걸린다.
  - **타입만** 쓰는 dsh 패키지와 `@types/*`는 `devDependencies`.
  - 우리 패키지는 `workspace:*`.

번들에 싣기:

- `packages/bundle/cordis.patch.yml`의 `insert`에 행(`id`, `name`, 있으면 `config`)을 더하고, `packages/bundle/package.json`의 `dependencies`에 그 패키지를 더한다. 이 두 파일은 여럿이 닿으므로 지휘 세션이 고친다(`AGENTS.md` "구현 작업 분담").
- 환경 변수로 받는 설정은 행의 `config`에서 `!!js process.env.CS_… || undefined`로 읽는다.
- 조합 시험의 시나리오가 값으로 가져오는 패키지는 루트 `package.json`의 `devDependencies`에도 `workspace:*`로 넣는다.

호스트 절반:

- 서비스를 주는 플러그인은 `Service`를 상속한 클래스를 기본 export로 둔다. 기다릴 서비스는 `static inject`, 설정은 `static Config`(schemastery)다. 서비스의 타입은 같은 파일에서 `declare module "@deepseek-ai/cordis"`로 `Context`에 붙인다. 서비스가 없는 플러그인은 `name`과 `apply(ctx)`를 export한다.
- 상태 조각의 타입은 `declare module "@cs/project/types"`로 `ComponentStates`에 붙인다. `"@cs/project"`로 보강하지 않는다: 한 프로그램에서 둘을 섞으면 한쪽의 보강이 보이지 않고(2-3b에서 밟았다), `@cs/project`는 호스트 모듈이라 브라우저 절반이 읽는 타입 모듈에 둘 수 없다.
- 다른 기능 컴포넌트의 것을 쓸 때는 그 컴포넌트의 서비스(`ctx.csWorkflow.resolve`)나 순수 함수 모듈(`@cs/workflow/files`)을 쓴다. 다른 컴포넌트의 조각을 타입으로 가져오지 않고, 꼭 읽어야 하면 모양을 확인하며 읽는다(생성이 에셋의 검토 상태를 읽는 `reviewOf`). 다른 컴포넌트의 연산을 이름으로 부르지 않는다.
- 연산의 `label`(화면에 보이는 한국어)은 패키지의 `strings.ts`에 둔다. 에이전트가 읽는 `description`과 `summarize`의 글은 영어이고 연산 옆에 둔다.
- 있어야 도는 서비스는 `inject`에 적는다. 있으면 쓰는 서비스는 `ctx.inject(["이름"], (inner) => …)`로 그 서비스가 있는 동안만 등록하거나 `ctx.get("이름")`으로 읽는다(`ctx.이름`은 주입하지 않았으면 던진다).
- 등록(도구, 라우트, 리듀서, 연산)은 정리 함수와 짝을 맞춰 `ctx.effect`에 넣는다. 플러그인이 내려갈 때 자기가 연 것(열어 둔 응답, 타이머)을 직접 닫는다.
- **브라우저 절반이 타입으로 읽는 모듈은 dsh의 호스트 패키지를 타입으로도 가져오지 않는다.** 호스트 선언이 따라와 브라우저 프로그램의 서비스 타입을 덮는다. 그래서 브라우저로 나가는 타입은 따로 뗀 진입점에 둔다(`@cs/api/wire`, `@cs/project/types`).
- 프로젝트를 바꾸는 코드는 프로젝트 계층의 연산 실행(`ctx.csProject.run`)만 부른다. 기록 파일을 직접 쓰지 않는다.
- 연산마다 에이전트가 부르면 무엇이 되는지를 `agent` 칸으로 정한다(2-3a): 적지 않으면 바로 실행(`run`), 사용자의 승인이 필요한 것(삭제, 캐릭터 프로필 쓰기)은 `propose`, 사용자만 하는 것(채택·보류, 화면에서 올린 파일의 가져오기)은 `none`이다. 제안 연산을 따로 만들지 않는다.
- 도메인 오류는 그 패키지의 오류 클래스로 던진다(`ProjectError`, `OperationFailure`, `RequestRejected`, `ApiRequestError`, `ComfyError`). 화면용 API는 `ApiRequestError`의 상태 코드로 답한다.

화면용 API에 라우트를 더할 때(`@cs/api`):

- 경로는 `ROUTES` 상수에 더한다. fetch 라우트는 `/api/cs/` 아래의 정확 일치 경로이고 메서드는 `GET`·`HEAD`·`POST`뿐이다. 인증은 dsh가 한다(소유자만 닿는다).
- 응답을 열어 두는 라우트(이벤트 스트림)는 dsh가 인증해 주지 않는다. 처리기에서 `ctx.connection.admit`으로 소유자인지 직접 본다.
- 브라우저로 나가는 모양은 `wire.ts`의 `Wire*` 타입이다. 프로젝트 계층의 내부 타입을 그대로 내보내지 않는다.

## 브라우저 절반

자리는 `packages/<이름>/src/client/`다. 빌드(`pnpm build`, `scripts/build-client.ts`)가 `src/client/index.ts`에서 `lib/client.js`를 만든다. 근거는 `docs/DSH.md` "브라우저 절반"이다.

- **React 18.3.1 위에서 돈다.** React는 dsh의 것을 같이 쓰고 번들에 싣지 않는다. React 19 전용 API(`use`, `useOptimistic`, `useActionState`, `<Activity>`, prop으로 받는 `ref`, `<Context value>`)를 쓰지 않는다.
- **값으로 가져올 수 있는 dsh 모듈은 공유 모듈 표의 열한 개뿐이다**(`docs/DSH.md` "공유 모듈 표"). 그 밖의 `@deepseek-ai/*`는 타입만 가져온다. 빌드가 어기는 import를 거절한다.
- **타입 import는 `import type { X } from "…"`로 쓴다.** `import { type X } from "…"`는 값 import로 남아 빌드가 거절한다. 서비스의 타입을 붙이는 import는 `import type {} from "<패키지>/client"`다.
- **진입점은 `inject`와 `apply`만 export한다.** 등록은 `apply` 안에서만 하고 모듈 최상위에 부작용을 두지 않는다.
- **React 컴포넌트는 `ctx`를 보지 않는다.** `ctx`를 쓰는 파일을 패키지 안에서 몇 개로 묶는다(셸은 `index.ts`, `host.ts`, `views.ts`, `chrome.ts`와 한 줄짜리 감싸기가 있는 `actions.ts`·`follow.ts`). React 컴포넌트는 슬롯이 주는 props, 틀이 만든 훅, 등록의 `inject`가 돌려준 값·콜백·`hooks`만 쓴다. React 컴포넌트 안에서 `useSyncExternalStore`로 직접 구독하지 않는다.
- **dsh 서비스는 좁은 인터페이스 하나로 감싼다**(셸의 `host.ts`의 `ShellHost`). 동작과 구독의 규칙은 그 인터페이스만 보는 모듈에 두고, 단위 시험은 손으로 만든 호스트로 돈다. 문자열 id를 dsh의 브랜드 id로 바꾸는 곳도 그 한 파일이다.
- **스타일은 CSS Modules**(`*.module.css`)다. 맨 `.css`는 빌드가 거절한다.
  - 우리 CSS는 우리 클래스에만 건다. 맨 요소 선택자와 전역 리셋을 넣지 않는다.
  - 색은 dsh 토큰(`--dsw-alias-*`)으로 쓴다. 색 값을 직접 적지 않는다. 라이트와 다크를 따로 손대지 않는다.
  - UI 라이브러리와 Tailwind를 더하지 않는다. dsh 기본 부품(`@deepseek-ai/dsh-client-ui-primitives`)과 자체 부품으로 그린다.
- **화면 문자열은 패키지의 `strings.ts` 한 모듈에 모은다.** 한국어다. React 컴포넌트에 문자열을 직접 적지 않는다. dsh의 로케일 사전(`ctx.locale`)에 넣지 않는다(사용자가 정했다, 2026-11-28). 값이 끼는 문자열은 그 모듈의 함수로 둔다(`createdOn(date)`).
- **모듈과 조합 시험이 같이 쓰는 id는 `ids.ts`에 둔다**(탭 id, 슬롯 이름, 등록 id).
- **시험이 잡을 요소에는 `data-cs-*` 속성을 둔다.** 시험은 화면 문자열이나 클래스 이름으로 요소를 찾지 않는다.
- **화면용 API는 클라이언트 모듈 하나를 거쳐 부른다**(셸의 `api.ts`). React 컴포넌트에서 `fetch`를 직접 부르지 않는다. 응답의 타입은 `@cs/api/wire`에서 타입으로 가져온다.
- **dsh 내부 구조에 기대는 장치는 한 파일에 모은다**(셸의 `chrome.ts`와 `chrome.module.css`). 파일 머리의 주석에 장치마다 무엇에 기대는지와 dsh 버전을 올릴 때 다시 볼 것을 적고, 조합 시험이 장치마다 본다. 장치를 더하는 것은 사용자가 정한다(지금은 둘이다. `docs/DSH.md` "dsh 내부에 기대는 장치").
- 화면은 덧붙이기가 아니라 교체다. 채팅과 입력창, 3단 프레임, 설정 화면은 dsh 것을 슬롯으로 재배치해 쓴다(`AGENTS.md` "꼭 지킬 것").

## 시험

- **단위 시험**(`pnpm test`): 대상 옆의 `<대상>.test.ts`. dsh 프로세스를 띄우지 않는다. 실제 Cordis `Context`에 dsh 플러그인을 올리는 시험은 단위 시험이다(`packages/project/src/testing/workspaces.ts`).
- **조합 시험**(`pnpm test:integration`): `tests/integration/<주제>.test.ts`. dsh를 임시 home으로 실제로 띄운다. 틀과 쓰는 법은 `docs/DSH.md` "띄워서 확인하는 법"이다.
  - 새 화면이나 호스트 쪽 서비스에는 그것을 보는 조합 시험을 같이 쓴다.
  - 시험은 `launchDsh`와 `openPage`를 `try`/`finally`로 감싸 `stop()`과 `close()`를 반드시 부른다.
  - 시험 끝에 콘솔 오류·경고가 0건인지 본다(`session.issues`).
  - 채팅의 턴은 가짜 LLM 서버(`startFakeLlm`)로 돈다. 실제 모델의 주소와 이름은 저장소에 적지 않는다.
  - dsh 자신의 DOM을 잡는 선택자는 상수 한 곳에 모은다(`tests/integration/chat-rig.ts`의 `DSH_CHAT`. 채팅을 도는 시험이 같이 쓰는 도우미도 거기 있다). 공개 계약이 아니라서 버전을 올릴 때 다시 본다.
  - dsh 프로세스 안에서 도는 시나리오(`tests/integration/scenarios/`)와 시험용 플러그인(`fixtures/`)은 Node가 바로 읽는다. 지울 수 있는 문법만 쓰고 `expect`를 쓰지 않는다.
- 틀이 내보내는 글은 로그인 주소와 토큰을 가린다(`redactLoginUrls`). 시험과 로그에 주소를 찍지 않는다.
- 화면이 걸린 변경은 타입 검사와 단위 시험이 통과해도 띄워서 본다(`AGENTS.md` "확인하는 법").

## 가져온 코드

- dsh와 DreamVerse의 코드(MIT)를 가져오면 `THIRD_PARTY_NOTICES.md`에 출처(저장소, 커밋), 가져온 범위, 바꾼 것을 적는다.
- 가져온 코드는 이 저장소의 규칙으로 맞춘다: 이름을 cs 계열로 바꾸고, 지울 수 있는 문법으로 풀고(생성자 매개변수 속성 → 필드 선언), Prettier와 oxlint를 통과시키고, 시험을 대상 옆으로 옮긴다(2-0).
- 원본과 동작이 달라진 곳은 그 단계의 단계 계획 문서와 `THIRD_PARTY_NOTICES.md`에 적는다.
- 기존 `comfy-studio`의 코드를 옮길 때는 공개해도 되는지를 그 단계에서 사용자가 확인한다. 특정 배포를 가리키는 이름과 값은 일반 이름으로 바꾸고, 시험 픽스처에 실제 주소·키·개인 데이터가 없는지 본다(4-0).
- **계획 2에서는 기존 `comfy-studio`의 코드를 옮기지 않는다**(사용자가 정했다, 2026-11-28). 코드, 시험, 에이전트 도구 설명문을 가져오지 않고 동작만 보고 새로 쓴다. 기존 저장소의 글을 그대로 붙이지 않는다.

## 문서

- 사실에는 확인 수준(띄워 확인, 소스 확인, 미확인)과 날짜를 붙인다(`AGENTS.md` "확인 수준").
- 이 저장소의 문서는 대문자 이름으로, dsh와 DreamVerse 저장소 안의 경로는 "업스트림" 또는 "DreamVerse"라고 밝혀 적는다.
- 단계를 시작할 때 `docs/PLAN_<단계>.md`를 쓰고, 끝나면 `docs/archive/`로 옮긴다. 사용자가 정한 것은 `docs/DECISIONS.md` "확정"에 사용자의 말 그대로 적고, Claude가 고른 기본값은 "전제"에 적는다.
- 코드와 문서는 같은 커밋에서 맞춘다(`AGENTS.md` "작업 후 문서 갱신").
- 기존 앱의 운영 데이터, 사용자의 서버·배포 환경, 모델 서버의 주소와 모델 이름, 로그인 주소를 문서·코드·커밋 메시지·PR에 적지 않는다.
