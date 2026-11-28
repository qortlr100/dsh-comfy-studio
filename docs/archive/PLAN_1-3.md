# 단계 계획 — 1-3 실제 모델로 채팅 확인

`docs/ROADMAP.md` 1-3의 상세 계획이다. 브랜치는 `1-3-live-chat`이다(2026-11-28).

## 범위

로드맵의 1-3은 3-0보다 먼저 적혔다("시험용 코드로 채팅을 우측 탭에 넣고…"). 3-0이 채팅 탭을 이미 만들었으므로 이 단계가 하는 일은 셋이다.

1. **실제 모델로 띄워 확인한다.** 모델 키가 없어 다른 단계가 "미확인"으로 남긴 것을 전부 본다(아래 "확인할 것").
2. **그 확인을 조합 시험으로 남긴다.** 실제 모델은 저장소 밖에 있으므로, 시험은 OpenAI 호환 응답을 흉내 내는 가짜 LLM 서버를 dsh에 붙여서 돈다. 키 없이 `pnpm test:integration`에서 늘 돈다.
3. **결과를 문서에 반영한다.** `docs/DSH.md`가 주이고, 미확인 표시가 풀리는 다른 문서도 고친다.

범위 밖: 에이전트 프리셋에 무엇을 넣을지(1-4. 이 단계는 기본 제공 `standard` 프리셋 그대로 본다), 채팅 안의 카드(3-4), 예약·MCP·스킬·웹 검색·서브에이전트의 실제 동작(1-4), 리버스 프록시 뒤의 접속(1-5).

## 쓴 모델

사용자가 준 **OpenAI 호환 서버**의 추론 모델이다(2026-11-28). 주소와 모델 이름은 이 저장소에 적지 않는다. 설정은 gitignore된 home에만 둔다.

- 프로토콜은 OpenAI Chat Completions이고, 추론은 응답의 `reasoning_content`로 따로 온다. 도구 호출과 스트리밍(`usage` 포함)을 지원한다.
- dsh의 기본 구성(DeepSeek 프로바이더)이 아니다. 그래서 DeepSeek 경로에서만 다를 수 있는 것(추론 표시, 웹 검색)은 이 단계의 확인에 들지 않는다.

## 확인할 것

| # | 항목 | 미확인으로 남긴 곳 |
| --- | --- | --- |
| 1 | 우측 탭의 채팅에서 메시지가 오가고, 추론·도구 호출이 그려진다 | 로드맵 1-3, `docs/DSH.md` "확인하지 못한 것" |
| 2 | 전송과 중지가 된다 | 로드맵 1-3 |
| 3 | 브라우저를 닫아도 턴이 끝까지 돈다 | 로드맵 1-3, `docs/LEGACY.md` 대응표 |
| 4 | 기본 프리셋의 셸 도구가 돈다(pnpm이 `node-pty` 등의 설치 스크립트를 돌리지 않은 상태) | 로드맵 1-0 후속, `docs/DSH.md` "함정" |
| 5 | 프리셋 밖에서 `tools` 서비스에 등록한 도구(연산 도구, 프로젝트 도구)가 에이전트의 도구 목록에 들어간다 | 2-0, `docs/DSH.md` "에이전트 프리셋" |
| 6 | 시스템 프롬프트에 프로젝트 규칙 절이 들어가고, 프로젝트 상태·갱신 메시지가 실제 턴에 붙는다 | 2-0, `docs/ARCHITECTURE.md` "프로젝트 계층" |
| 7 | 에이전트가 만든 기록에 턴 번호와 세션이 남는다 | 2-0 |
| 8 | 대화가 있는 세션이 여럿일 때 내비게이터의 목록과 전환 | 3-0 |
| 9 | 사용자 지정 프로바이더를 dsh에 붙이는 설정 | `docs/DSH.md` "dsh가 이미 주는 기능" |

## 고른 것

Claude가 고른 것이다. 사용자가 정할 "미정"은 이 단계에 없다.

- **확인은 가짜 LLM 서버로 남긴다.** 실제 모델을 부르는 시험을 환경 변수로 켜는 안(주소를 저장소에 적지 않아도 된다)도 있지만, 모델의 답이 매번 달라 단언이 약하고 사용자 장비 밖에서는 돌지 않는다. 가짜 서버는 dsh가 보낸 요청(도구 목록, 메시지)을 그대로 볼 수 있어서 5~7번을 직접 단언한다. 실제 모델로는 이 단계에서 한 번 띄워 보고 결과를 문서에 적는다.
- **가짜 서버는 `--patch`로 붙인다.** `llm-pi-ai` 행에 프로바이더 하나를, `agent-default-model` 행에 그 프로바이더와 모델을 적는다. 키 대신 `headers.Authorization`을 준다(dsh의 OpenAI 호환 구현은 키나 이 헤더가 없으면 요청을 보내지 않는다).
- **셸 도구는 조합 시험에 넣는다.** 1-4가 프리셋에서 셸 도구를 빼기로 하면 그 단언은 그때 같이 지운다.
- **dsh의 채팅 DOM은 시험에서만 잡는다.** 슬롯 이름(`data-slot`)과 dsh가 붙이는 `data-*` 속성으로 찾는다. 공개 계약이 아닌 속성은 `tests/integration/chat.test.ts` 한 곳에 모으고, 버전을 올릴 때 다시 본다.

## 틀의 명세

### `tests/harness/llm.ts` — 가짜 LLM 서버

OpenAI Chat Completions를 흉내 내는 HTTP 서버다. 시험이 준 **대본 함수**가 요청마다 답을 정한다. dsh에 의존하지 않는다(Node 내장 모듈과 `./dsh.ts`의 `tempParent`만 쓴다).

```ts
/** One reply, streamed in this order: reasoning, text, tool calls. */
export interface FakeReply {
  reasoning?: string;
  text?: string;
  toolCalls?: readonly { name: string; arguments: Readonly<Record<string, unknown>> }[];
  /** Wait before the first chunk. Default 0. */
  delayMs?: number;
  /** Wait between two chunks. Default 0. */
  chunkDelayMs?: number;
}

export interface FakeMessage {
  role: string;
  /** Text parts joined with "\n"; a part that is not text shows as `[<type>]`. */
  text: string;
  /** The assistant's tool calls. */
  toolCalls: readonly { id: string; name: string; arguments: string }[];
  /** On a `tool` message: the call it answers. */
  toolCallId: string | undefined;
}

export interface FakeRequest {
  /** Position among the chat requests, from 0. */
  readonly index: number;
  readonly model: string;
  /** Names of the offered tools; empty when none were sent (dsh's session-title request). */
  readonly tools: readonly string[];
  readonly messages: readonly FakeMessage[];
  /** The parsed body as it came. */
  readonly body: unknown;
  /** `open` while the reply is on its way, `aborted` when the client hung up first. */
  readonly state: "open" | "done" | "aborted" | "failed";
}

export type FakeScript = (request: FakeRequest) => FakeReply;

export interface FakeLlm {
  /** `http://127.0.0.1:<port>/v1` */
  readonly baseURL: string;
  /** Chat requests so far, oldest first. The array is live: poll it. */
  readonly requests: readonly FakeRequest[];
  /** A `--patch` file that makes this server the default model of the dsh it is given to. */
  readonly patch: string;
  /** Stops the server, ends open replies and deletes the patch file. Safe to call twice. */
  close(): Promise<void>;
}

export const FAKE_PROVIDER = "cs-test-llm";
export const FAKE_MODEL = "cs-test-model";

export function startFakeLlm(script: FakeScript): Promise<FakeLlm>;
```

- `POST /v1/chat/completions`(`stream: true`)에 SSE로 답한다. 조각의 순서: `role` 델타 → `reasoning_content` 델타들 → `content` 델타들 → 도구 호출마다 `tool_calls` 델타 하나(`index`, `id`, `type: "function"`, `function.name`, `function.arguments`에 JSON 문자열 전체) → `finish_reason`(도구 호출이 있으면 `tool_calls`, 없으면 `stop`) → `choices: []`와 `usage`만 든 조각 → `data: [DONE]`. 글은 낱말 단위로 쪼갠다(공백을 잃지 않는다).
- `stream`이 `true`가 아니면 400을 준다. `GET /v1/models`는 모델 하나의 목록을 준다. 그 밖의 경로는 404다.
- 클라이언트가 답이 끝나기 전에 끊으면 그 요청의 `state`가 `aborted`가 되고 남은 조각을 보내지 않는다.
- 대본이 던지면 500과 메시지를 주고 `state`는 `failed`다.
- 패치 파일은 `tempParent()` 아래 새 폴더에 JSON으로 쓴다(JSON은 YAML이다). 행은 둘이다: `llm-pi-ai`(`providers[FAKE_PROVIDER]`: `displayName`, `api: "openai-completions"`, `baseURL`, `headers: { Authorization: "Bearer cs-test" }`, `models: [{ id: FAKE_MODEL, name, contextWindow: 262144, maxTokens: 16384 }]`)와 `agent-default-model`(`provider`, `model`).
- 단위 시험 `tests/harness/llm.test.ts`: 조각의 순서와 모양, 요청 기록(도구 이름, 메시지 펴기), 끊었을 때 `aborted`, 대본이 던졌을 때, `close()` 뒤에 패치 파일이 없고 포트가 닫힌 것.

### `tests/harness/browser.ts` — 바꾸는 것

- `OpenPageOptions.modelConfigured?: boolean`(기본 `false`). 모델이 설정된 home에서는 "Get started" 창이 뜨지 않으므로 Preview Notice만 닫는다.
- `PageSession.openTab(): Promise<Page>`. 같은 브라우저 프로필(쿠키와 저장된 상태가 남는다)로 앱의 출처를 새 탭에 연다. 콘솔 오류를 같은 `issues`에 모은다. 탭을 닫았다가 다시 여는 시험에 쓴다.

### `tests/integration/chat.test.ts`

가짜 LLM을 붙인 dsh에서 본다. 시험용 기능 컴포넌트(`fixtures/memo-component.ts`)를 같이 얹는다.

1. **턴 하나**: 프로젝트를 만들고 메시지를 보낸다. 대본은 추론 + 연산 도구 호출(`cs_probe_memo_add`)을, 도구 결과가 오면 글을 준다. 단언: 요청의 도구 목록에 프로젝트 도구 여덟과 연산 도구가 있다, 시스템 프롬프트에 프로젝트 규칙이 있다, 프로젝트 상태 메시지가 있다, 기록에 `actor: agent`, `surface: chat`, `turn: "1"`, 세션이 남는다, 화면에 사용자 글·추론·도구 호출·답이 그려진다. 이어서 화면용 API로 연산을 실행하고 다음 턴의 요청에 갱신 메시지가 있는지 본다. 같은 세션에서 셸 도구(`bash`)를 부르는 턴도 돈다(도구 결과에 출력이 온다). 콘솔 오류·경고 0건.
2. **중지**: 느리게 흐르는 답 도중에 중지 버튼을 누른다. 가짜 서버의 요청이 `aborted`가 되고 입력창이 다시 보낼 수 있는 상태가 된다. 그 뒤의 턴이 돈다.
3. **탭을 닫아도 턴이 돈다**: 첫 요청이 답하기 전에 탭을 닫는다. 탭 없이 도구가 실행돼 둘째 요청이 오고 기록이 남는다. 같은 브라우저로 새 탭을 열면 같은 세션에 답이 보인다.
4. **세션 여럿**: 한 프로젝트에서 대화가 있는 세션 둘을 만들고 내비게이터로 오간다. 보이는 채팅이 고른 세션의 것이다. 새로고침 뒤에도 같은 세션이다.

## 분담

| 일 | 맡는 쪽 |
| --- | --- |
| 실제 모델로 띄워 확인, 명세, `browser.ts`, `chat.test.ts`, 문서, 통합과 검사 | 지휘 세션 |
| `tests/harness/llm.ts`와 `llm.test.ts` | 서브 에이전트(표준) 하나 |

## 완료 기준

- 위 "확인할 것" 아홉 항목의 결과가 `docs/DSH.md`에 확인 수준과 함께 적혀 있다.
- `pnpm check`와 `pnpm test:integration`이 통과한다.
- 안 되는 것이 있으면 병합하지 않고 사용자와 화면 구조를 다시 정한다(로드맵의 완료 기준).

## 결과

2026-11-28에 끝냈다. 아홉 항목 모두 됐고, 안 되는 것은 없었다. 항목별 결과는 `docs/DSH.md` "실제 모델로 확인한 것"과 "LLM 프로바이더 붙이기"에 있다.

### 실제 모델로 한 확인

임시 home(조합 시험의 틀)에 그 모델을 `--patch`로 붙이고, 헤드리스 브라우저로 우측 채팅에 글을 보냈다. dsh와 모델 사이에 요청을 기록하는 프록시를 두어 dsh가 보낸 것을 봤다. 확인에 쓴 스크립트는 저장소에 넣지 않았다(주소가 들어 있고, 같은 확인을 `chat.test.ts`가 한다).

| # | 한 것 | 본 것 |
| --- | --- | --- |
| 1 | 한마디를 보냈다. 셸 명령을 시켰다 | 답이 그려지고 세션 제목이 붙는다. 접힌 턴을 펼치면 "Think" 줄과 도구 호출 줄이 있다. 콘솔 오류 0건 |
| 2 | 긴 답 도중에 중지 버튼을 눌렀다 | 약 1.5초 안에 멈추고 프록시에서 요청이 끊긴다. 다음 턴이 돈다 |
| 3 | `sleep`을 시키고 브라우저를 닫았다. 같은 브라우저에서 탭만 닫았다가 다시 열기도 했다 | 브라우저 없이 도구가 끝나고 모델의 답까지 온다. 탭을 다시 열면 같은 세션이 도는 중인 모습으로 보이고 끝까지 간다 |
| 4 | `echo cs-shell-ok-$((6*7))` | `cs-shell-ok-42`가 도구 결과로 온다 |
| 5 | 요청의 도구 목록을 봤다. `cs_proj_state`와 시험용 연산 도구를 부르게 했다 | 39개 가운데 `cs_proj_*` 여덟 개가 있고(시험용 기능 컴포넌트를 얹으면 그 연산 도구도), 불러서 실행된다 |
| 6 | 요청의 메시지를 봤다. 화면용 API로 연산을 실행한 뒤 다음 턴을 보냈다 | 시스템 프롬프트에 "Project rules:" 절, 첫 턴에 "Project state." 메시지, 다음 턴에 "Project updates since your last step" 메시지 |
| 7 | 기록 파일을 읽었다 | 에이전트의 기록에 `actor: agent`, `surface: chat`, `turn: "1"`, 세션 |
| 8 | 한 프로젝트에서 새 채팅을 만들어 세션 둘에 대화를 두고 오갔다 | 목록에 제목과 함께 둘이 뜨고, 누른 세션의 대화가 보인다. 새로고침해도 같은 세션이다 |
| 9 | `--patch`와 프로필의 `cordis.patch.yml` 둘 다로 붙였다. 키 대신 `Authorization` 헤더, 그리고 `apiKeyEnv` + 환경 변수 둘 다 해 봤다. 추론 강도 설정을 바꿔 가며 보냈다 | 둘 다 된다. `reasoningEfforts`를 적으면 입력창에 추론 강도 선택이 생기고 `reasoning_effort`로 간다 |

### 만든 것

| 파일 | 내용 |
| --- | --- |
| `tests/harness/llm.ts`, `llm.test.ts` | 가짜 LLM 서버와 단위 시험 7개 |
| `tests/harness/browser.ts` | `openPage`의 `modelConfigured`, `PageSession.openTab()` |
| `tests/integration/chat.test.ts` | 조합 시험 넷(약 21초): 턴 하나, 중지, 탭을 닫아도 도는 턴, 세션 여럿 |

조합 시험 전체는 17개, 약 24초다. `chat.test.ts`는 세 번 연달아 돌려 흔들리지 않는 것을 봤다.

### 계획과 달라진 것

- 가짜 서버의 패치 파일 이름은 `llm.patch.yml`이다(명세는 폴더만 정했다). 잘못된 JSON 본문과 `stream`이 아닌 요청은 400이고 `requests`에 남지 않는다. `close()`가 끝낸 답의 `state`는 `open`으로 남는다.
- 셸 도구의 턴은 접힌 턴 안의 DOM이 아니라 모델에게 돌아간 도구 결과로 단언한다(끝난 턴의 도구 호출은 접힌 동안 DOM에 없다).

### 하다가 알게 된 것

`docs/DSH.md`에 옮겨 적었다: 키가 없는 서버에도 `Authorization` 헤더가 있어야 한다, 모델이 잡힌 home에서는 "Get started" 창이 뜨지 않는다, 사용자의 글 뒤에 끼워 넣는 메시지가 있어 마지막 `user` 메시지가 사용자의 글이 아니다, 첫 메시지 뒤에 제목 요청이 따로 간다, 저장된 상태가 없는 브라우저로 열면 새 빈 채팅이 열린다, `standard` 프리셋의 에이전트가 받는 도구 31개.

### 저장소 밖에서 한 것

사용자의 개발용 home(`.dsh-home`, gitignore) 프로필의 `cordis.patch.yml`에 그 모델의 프로바이더 행과 기본 모델 행을 넣었다. `pnpm dsh:start`로 띄우면 그 모델로 채팅이 된다. 같은 내용을 임시 home의 프로필 패치에 넣어 메시지가 오가는 것을 먼저 봤다.

### 남긴 것

- DeepSeek 프로바이더에서의 추론 표시와 웹 검색, 승인을 묻는 도구, 첨부와 이미지 입력, 설정 화면의 폼으로 프로바이더를 추가하는 것은 보지 않았다.
- 저장된 상태가 없는 브라우저로 열 때 앞 세션을 열게 할지(1-5).
- 에이전트가 받는 도구와 페르소나는 `standard` 그대로다. 셸·파일 도구를 줄지는 1-4가 정하고, 빼기로 하면 `chat.test.ts`의 셸 도구 단언을 같이 지운다.

### 리뷰에서 고친 것

- `docs/DSH.md` "LLM 프로바이더 붙이기"의 예시가 `Authorization` 헤더에 값을 직접 적는 꼴이었다. 인증이 있는 서버에 그대로 따르면 토큰이 설정 파일에 평문으로 남는다. 예시를 키의 참조(`apiKeyEnv`)로 바꾸고, 헤더에 값을 직접 적는 것은 인증이 없는 서버의 자리 채우기에만 쓴다고 적었다.
