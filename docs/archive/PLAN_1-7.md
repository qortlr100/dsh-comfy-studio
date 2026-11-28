# 단계 계획 — 1-7 규칙 문서

`docs/ROADMAP.md` 1-7의 계획과 결과다. 브랜치는 `1-7-conventions`이다(2026-11-28). 문서만 바꾸는 단계다.

## 범위

코드가 생기며 정해진 규칙을 `docs/CONVENTIONS.md` 하나로 모은다. 로드맵이 든 세 가지(디렉터리 규칙, 플러그인 한 개의 모양, 브라우저 절반의 규칙)와, 같이 있어야 찾기 쉬운 것(이름, 시험, 가져온 코드, 문서)을 담는다.

- **새 규칙을 만들지 않는다.** 이미 정해져 코드와 다른 문서에 흩어져 있던 것만 옮긴다. 줄마다 정해진 곳이나 지키게 하는 장치를 적는다.
- 이유와 띄워 확인한 사실은 원래 문서(`docs/DSH.md`, 단계 계획 문서)에 그대로 두고 가리키기만 한다. 같은 사실을 두 곳에 길게 적지 않는다.
- `AGENTS.md` "꼭 지킬 것"은 그대로 둔다. 그것은 하지 않는 것의 목록이고, 규칙 문서는 코드를 쓰는 모양이다.

사용자가 정할 "미정"은 이 단계에 없다. Claude가 새로 고른 기본값도 없다.

## 모은 곳

| 규칙 문서의 절 | 규칙이 있던 곳 |
| --- | --- |
| 일반 | `tsconfig.base.json`, `.prettierrc`, `.oxlintrc.json`, `docs/archive/PLAN_1-0.md`(버전 고정), `PLAN_1-2.md`(타입 기반 린트), `PLAN_2-0.md`·`PLAN_4-0.md`(타입 단언과 시험 도우미) |
| 이름 | `docs/DECISIONS.md` "확정"(cs 계열), `packages/ui-shell/src/client/ids.ts`, `docs/DSH.md` "CSS", 코드의 파일 이름 |
| 디렉터리 | 저장소의 배치, `docs/ARCHITECTURE.md` "패키지 구성" |
| 플러그인 패키지 하나의 모양 | `docs/DSH.md` "플러그인 패키지 하나의 모양"·"호스트 쪽", `PLAN_2-0.md`(의존성의 자리), `packages/*/package.json`, `packages/api/src/index.ts` |
| 브라우저 절반 | `docs/DSH.md` "브라우저 절반"(번들 형식, CSS, 공유 모듈 표, 타입, 업스트림의 브라우저 코드 규칙), `AGENTS.md` "명령"·"꼭 지킬 것", `packages/ui-shell/src/client/` |
| 시험 | `docs/DSH.md` "띄워서 확인하는 법", `AGENTS.md` "확인하는 법", `PLAN_1-2.md`·`PLAN_1-3.md` |
| 가져온 코드 | `THIRD_PARTY_NOTICES.md`, `PLAN_2-0.md`·`PLAN_4-0.md` |
| 문서 | `AGENTS.md` "확인 수준"·"작업 후 문서 갱신", `docs/ROADMAP.md` "단계를 다루는 법" |

## 결과

- `docs/CONVENTIONS.md`를 썼다.
- `AGENTS.md`: "문서 지도"에 규칙 문서의 줄을 더하고, "작업 후 문서 갱신"의 "1-7에서 만든다"를 지웠다.
- `docs/ROADMAP.md`: 1-7을 끝냈다고 적었다.
- 코드는 바꾸지 않았다. 검사 명령을 돌릴 것이 없다(Markdown은 Prettier와 린트의 대상이 아니다).

### 남긴 것

- 화면 문자열의 규칙은 지금의 임시 규칙(패키지마다 `strings.ts`)으로 적었다. 1-6이 정하면 그 단계가 규칙 문서의 그 줄을 고친다.
- 자체 부품과 토큰의 규칙은 3-1의 `docs/DESIGN.md`가 맡는다.
- 기능 컴포넌트 하나의 모양(연산, 리듀서, 도구 설명)은 2-3에서 첫 기능 컴포넌트를 만들 때 더한다. 지금은 시험용 픽스처(`tests/integration/fixtures/memo-component.ts`)밖에 없다.
