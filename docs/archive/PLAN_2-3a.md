# 2-3a 단계 계획 — 제안 장치와 에이전트 호출 방식

2-3(기능 컴포넌트)의 첫 갈래다. 기능 컴포넌트를 만들기 전에 프로젝트 계층(`@cs/project`)에 둘을 더한다: 연산마다 "에이전트가 부르면 무엇이 되는가"를 정하는 칸, 그리고 에이전트의 호출을 제안으로 남겼다가 사용자가 승인하면 실행하는 장치. 에셋 삭제(2-3b), 캐릭터 프로필(2-3e), 프리셋 변경(2-3f)이 이 장치를 쓴다.

## 2-3 전체에 걸리는 결정

사용자가 2026-11-28에 정했다(`docs/DECISIONS.md` "확정").

| 물은 것 | 답 | 뜻 |
| --- | --- | --- |
| 2-3을 PR 몇 개로 나눌지 | "갈래마다 PR" | 기능 컴포넌트 하나가 브랜치·PR 하나다. 갈래: 2-3a 제안 장치, 2-3b 에셋, 2-3c 워크플로, 2-3d 생성, 2-3e 캐릭터, 2-3f 프리셋, 2-3g 프로젝트 문서, 2-3h 웹 검색, 2-3i 예약 도구 |
| 워크플로·캐릭터·프리셋의 자리 | "프리셋만 전역" | 프리셋은 dsh home의 저장소에 두고 모든 프로젝트에 적용한다. 워크플로와 캐릭터는 프로젝트의 기록이고 "다른 프로젝트에서 복사" 연산을 둔다 |
| "제안 후 승인"을 지키는 법 | "제안 기록 + 승인" | 이 문서의 장치 |
| 기존 앱 코드를 옮길 범위 | "옮기지 않고 새로 씀" | 계획 2에서는 기존 `comfy-studio`의 코드, 시험, 도구 설명문을 옮기지 않는다. 동작만 보고 새로 쓴다 |

제안 장치는 사용자가 든 여덟 갈래에 없던 것이다. 여러 갈래가 같이 쓰는 바탕이라 맨 앞에 따로 뺐다(Claude가 고른 순서).

## 무엇을 만드나

### 연산의 `agent` 칸

`OperationSpec`에 선택 칸 하나를 더한다.

```ts
/** What an agent's call of an operation does. */
export type AgentCall = "run" | "propose" | "none";

interface OperationSpec {
  /**
   * What an agent's call does. `run` (the default) runs the operation at once. `propose` writes a proposal that the
   * user accepts or rejects; the operation runs only when the user accepts, as the user. `none` gives agents no tool.
   */
  agent?: AgentCall;
}
```

- `run`: 지금과 같다.
- `none`: 에이전트 도구를 만들지 않는다. 화면(화면용 API)만 부른다. 예: 채택·보류 같은 검토.
- `propose`: 도구는 있다. 부르면 실행하지 않고 제안을 남긴다.
- **한 곳에서 막는다.** `run`은 `actor: "agent"`인 요청이 `propose`·`none` 연산을 부르면 기록 없이 거절한다(`agent_not_allowed`). 도구 등록을 빠뜨려도 규칙이 선다.
- 읽기 전용 연산(`readOnly`)에 `propose`를 주면 등록을 거절한다(`invalid_params`).

### 제안

제안은 기록 두 가지다. 둘 다 `proj` 컴포넌트의 기록이고 **히스토리 밖**에 쓴다(`appendOutsideHistory`): 단계가 아니라서 실행 취소로 사라지지 않고, 뒤 단계를 버리지 않는다.

| 기록 | `params` | 누가 |
| --- | --- | --- |
| `proj.propose` | `{operation, operation_version, params, inputs: [{role, ref}], based_on, supersedes}` | 에이전트(도구 호출의 origin 그대로: 세션, 턴, 도구 호출 id, `intent`는 `reason`) |
| `proj.proposal_decide` | `{proposal, decision: "accepted" \| "rejected", record?}` | 사용자(승인·거절한 화면의 origin). `record`는 승인으로 실행된 연산의 기록 |

둘 다 `status: "done"`, `inputs: []`, `outputs: []`, `deterministic: true`이고 갱신 줄이 없다(`proj.stale_accept`와 같은 꼴).

`proj` 조각에 제안 목록이 생긴다. `proj` 리듀서가 위 두 기록에서 계산한다(히스토리 밖 기록은 현재 위치와 무관하게 전부 본다).

```ts
export interface Proposal {
  /** The `proj.propose` record. */
  id: RecordId;
  operation: string;
  operation_version: string;
  params: Record<string, unknown>;
  inputs: Array<{ role: string; ref: RecordInputRef }>;
  based_on: RecordId | null;
  supersedes: RecordId[];
  /** The agent's reason. */
  intent: string;
  session: SessionId | null;
  turn: TurnId | null;
  tool_call: string | null;
  created_at: string;
  status: "pending" | "accepted" | "rejected";
  /** When the user decided; absent while pending. */
  decided_at?: string;
  /** The record the accepted call wrote; absent while pending or rejected. */
  record?: RecordId;
}

interface ComponentStates {
  proj: {
    // …
    /** Every proposal of the project by its `proj.propose` record, pending and decided. */
    proposals: Record<RecordId, Proposal>;
  };
}
```

서비스(`ctx.csProject`)에 둘을 더한다.

| 메서드 | 하는 일 |
| --- | --- |
| `propose(request: RunRequest): Promise<ProjectRecord>` | `run`이 기록을 쓰기 전에 하는 검사(연산이 있는지, 파라미터, 입력 역할, 입력이 풀리는지, `precondition`)를 지금 상태에 대해 그대로 하고, 통과하면 `proj.propose` 기록을 쓴다. 거절은 `run`과 같은 오류다. 읽기 전용 연산은 거절한다. 같은 세션이 같은 연산·파라미터·입력으로 낸 제안이 아직 대기 중이면 새로 쓰지 않고 그 기록을 돌려준다 |
| `decideProposal(project, proposal, decision: "accept" \| "reject", origin): Promise<{ proposal: Proposal; result: RunResult \| null }>` | 거절이면 `proj.proposal_decide`를 쓴다. 승인이면 제안의 연산을 `origin`(사용자)으로 `run`하고, 기록이 생기면(끝 상태가 무엇이든) `record`를 담아 `proj.proposal_decide`를 쓴다. `run`이 기록 전에 거절하면 그 오류를 그대로 던지고 제안은 대기로 남는다. 이미 결정된 제안은 아무것도 쓰지 않고 지금 상태를 돌려준다(`result: null`). 같은 제안의 결정이 진행 중이면 `proposal_busy`. 모르는 id나 제안이 아닌 기록은 `unknown_record` |

- 승인된 호출의 `intent`는 `accept proposal: <제안의 intent>`다. `based_on`과 `supersedes`는 제안의 것을 넘긴다.
- 승인의 실행은 프로젝트 잠금 밖이다(`run`이 스스로 잠근다). 두 번 실행되지 않게 하는 것은 서비스가 쥔 "결정 중" 표시다.
- 재시작으로 승인 실행과 결정 기록 사이가 끊기면 제안은 대기로 남는다. 다시 승인하면 `precondition`이 지금 상태에 대해 다시 판단한다. 삭제처럼 "이미 없다"로 거절되는 연산은 사용자가 거절로 닫는다.

### 에이전트가 보는 것

- `propose` 연산의 도구 설명 끝에 한 문장이 붙는다: 부르면 실행되지 않고 사용자가 앱에서 수락하거나 거절하는 제안이 된다는 것.
- 도구 결과: `{record: <제안 기록 id>, status: "proposed", summary, outputs: [], scheduled: [], params}`. 오류가 아니다. 글은 "제안했다, 아직 바뀐 것은 없다, 사용자의 결정은 프로젝트 갱신으로 온다, 같은 제안을 되풀이하지 말라"를 말한다. `cs_seen`에는 제안 기록이 `done`으로 든다.
- 검사에서 걸린 제안(없는 에셋 등)은 지금처럼 도구 오류다. 기록이 남지 않는다.
- 프로젝트 요약(`cs_proj_state` 등)에 대기 중인 제안이 `proposals` 칸으로 든다(없으면 칸도 없다): 제안 id, 도구 이름, 이유.
- 사용자의 결정은 프로젝트 갱신 메시지에 줄로 온다(히스토리 밖 기록이 이미 실리는 자리). 승인이면 실행된 연산의 기록도 평소처럼 따로 실린다.
- 프로젝트 규칙 절(`cs:project`)에 규칙 하나를 더한다: 설명에 제안이라고 적힌 도구는 아무것도 바꾸지 않는다, 무엇을 제안했는지 글로 말한다, 결정을 기다리며 되풀이하지 않는다. "모든 호출은 바로 단계다"는 그런 도구를 뺀 나머지에 대한 말로 고친다.

### 화면용 API

| 경로 | 메서드 | 요청 | 응답 |
| --- | --- | --- | --- |
| `/api/cs/proposal/decide` | POST | `{project, proposal, decision: "accept" \| "reject", surface?, session?}` | `{proposal, record}`: 결정 뒤의 제안과, 승인으로 실행된 기록(없으면 `null`) |

- 제안 목록은 따로 라우트를 두지 않는다. 상태(`GET /api/cs/state`)의 `components.proj.proposals`에 있다.
- 상태의 `assets`에 대기 중인 제안의 입력이 가리키는 에셋을 더한다(카드가 썸네일을 그린다).
- 연산 선언(`GET /api/cs/operations`)에 `agent` 칸을 싣는다.
- `proposal_busy`와 `agent_not_allowed`는 409다(그 밖의 프로젝트 계층 거절과 같다).

## 고른 것

Claude가 고른 기본값이다. 사용자가 고른 안("제안 기록 + 승인") 아래의 세부다.

| 고른 것 | 이유 | 뒤집으면 |
| --- | --- | --- |
| 장치를 프로젝트 계층에 둔다. 기능 컴포넌트마다 제안 연산을 따로 만들지 않는다 | 연산 하나에 칸 하나면 된다. 화면과 에이전트가 같은 연산을 부른다는 규칙이 그대로다. 카드(3-4)와 승인 라우트가 하나다 | 컴포넌트마다 `x.delete_propose`·`x.delete`를 둔다 |
| 제안은 히스토리 밖의 기록이다 | 제안은 프로젝트 내용의 변경이 아니다. 실행 취소가 제안을 지우거나 제안이 뒤 단계를 버리면 안 된다 | 단계로 쓴다(`append`) |
| 승인하면 같은 연산을 사용자 이름으로 실행한다. 승인 전용 연산을 두지 않는다 | 실행된 기록이 평소의 기록과 같아서 리듀서가 제안을 몰라도 된다 | — |
| 승인 때 지금 상태로 다시 검사한다 | 제안과 승인 사이에 상태가 바뀔 수 있다 | — |
| `agent`는 값 셋이고 함수가 아니다 | 호출마다 달라지는 경우(자동 개선을 켠 프리셋의 부분 수정)는 프리셋이 전역이 되면서 프로젝트 연산이 아닐 수 있다. 2-3f에서 필요하면 넓힌다 | 함수도 받게 한다 |
| 제안에 만료가 없다 | 기존 앱도 없었다 | 리듀서가 시각으로 접는다 |
| 결정된 제안도 상태에 남긴다 | 카드가 결과를 그린다. 작다 | 리듀서가 최근 것만 남긴다 |

## 일의 나눔

| 묶음 | 파일 | 누가 |
| --- | --- | --- |
| 프로젝트 계층: 타입, 실행기, 리듀서, 도구, 요약, 갱신 메시지, 규칙 절과 그 시험, `CONTRACTS.md` | `packages/project/**` | 서브 에이전트(상위) |
| 화면용 API: 결정 라우트, 상태의 에셋, 연산 선언의 `agent`와 그 시험 | `packages/api/**` | 같은 서브 에이전트 |
| 조합 시험: 가짜 LLM이 `propose` 연산의 도구를 부른다 → 제안이 상태에 뜬다 → 페이지에서 승인 → 기록이 생긴다 → 다음 턴에 갱신이 간다. `none` 연산은 도구 목록에 없다 | `tests/integration/proposal.test.ts`, `tests/integration/fixtures/` | 같은 서브 에이전트가 쓰고 지휘 세션이 돌린다 |
| 문서 | `docs/**`, `AGENTS.md` | 지휘 세션 |

## 완료 기준

- `pnpm check`와 `pnpm test:integration`이 통과한다.
- 단위 시험이 본다: `agent` 값마다의 도구 등록, `run`의 에이전트 거절, `propose`의 검사와 중복 접기, `decideProposal`의 승인·거절·이미 결정됨·진행 중·기록 전 거절, 실행 취소 뒤에도 제안이 남는 것, 요약과 갱신 메시지의 글, 재시작 뒤 다시 읽기.
- 조합 시험이 위 흐름을 실제 dsh에서 본다.

## 결과

2026-11-29에 끝났다. 계약(타입, 기록의 모양, 메서드, 오류 코드, 라우트)은 위 그대로다.

확인한 것:

- `pnpm check` 통과(단위 시험 703개. 새로 쓴 것 22개, 고친 것 6개).
- `pnpm test:integration` 통과(26개). 새 시험 `tests/integration/proposal.test.ts`가 실제 dsh에서 본다: 가짜 LLM이 `propose` 연산의 도구를 부른다 → 상태에 대기 중인 제안이 뜨고 다른 것은 그대로다 → 페이지에서 승인한다 → 연산의 기록이 `actor: "user"`로 생긴다 → 다음 턴의 요청에 결정을 알리는 프로젝트 갱신이 실린다. `none` 연산의 도구는 모델이 받는 도구 목록에 없다.
- 실제 모델로는 돌려 보지 않았다(**미확인**). 에이전트가 읽는 글은 가짜 LLM으로만 봤다.

구현하며 더 정한 것(Claude가 고른 기본값):

| 정한 것 | 이유 |
| --- | --- |
| `decideProposal`은 `actor: "agent"`인 origin을 `agent_not_allowed`로 거절한다 | 결정은 사용자만 한다 |
| 승인한 호출의 입력이 아직 끝나지 않은 기록의 출력이면 실행을 예약한다(`after: []`) | 화면용 API의 연산 실행이 하는 것과 같다 |
| 제안은 요청이 준 `based_on`과 `supersedes`만 담는다. 연산이 스스로 더하는 것은 승인으로 실행될 때 붙는다 | 그때의 상태로 계산돼야 한다 |
| `propose`는 연산의 `agent` 값을 보지 않는다. 읽기 전용이 아니면 어느 연산이든 제안할 수 있다 | 호스트 코드가 쓰는 서비스다. 에이전트의 길은 도구가 정한다 |
| 제안 뒤에 연산의 버전이 바뀌어도 승인은 지금의 선언으로 실행한다 | 파라미터 검사가 다시 돈다 |
| 상태의 `assets`에 드는 것: 대기 중인 제안의 입력이 가리키는 에셋, 현재 상태에 있는 기록의 출력, 참조 종류의 버전이 가리키는 에셋 | 카드가 그릴 것 |

에이전트가 읽는 글(영어, `packages/project/src/`):

- 도구 설명의 끝: "Calling this tool does not run it: the call writes a proposal that the user accepts or rejects in the app."(`agent-tools.ts`의 `PROPOSE_HINT`)
- 도구 결과: `proposed <id>: the call of <tool> waits for the user to accept or reject it in the app; nothing has changed yet. …`
- 갱신 줄: `accepted proposal <id> of <tool>; it ran as record <id>`, `rejected proposal <id> of <tool>; nothing ran`, 다른 채팅의 제안은 `proposed <tool>: <reason>`.
- 요약의 `proposals`: `[{proposal, tool, reason}]`. 기록 수 다음에 온다.
- 규칙 절의 두 줄은 `agent-context.ts`에 있다.
