# 2-3c 단계 계획 — 워크플로

2-3의 셋째 갈래다. 프로젝트의 워크플로(ComfyUI API 형식 그래프와 노출 필드)를 맡는 기능 컴포넌트 `@cs/workflow`를 만든다. 2-3 전체에 걸리는 결정은 `docs/archive/PLAN_2-3a.md`에 있다.

- 그래프와 필드의 순수 로직은 연동 라이브러리 `@cs/comfy`(4-0)의 것을 쓴다: `workflow`(파싱, 필드 추론, 값 묶기), `graph-patch`(패치 적용과 검증), `embedded-graph`(PNG에서 그래프 읽기), `graph-text`.
- 연산, 리듀서, 에이전트가 읽는 글은 새로 쓴다. 기존 앱의 동작이 본이고 코드는 옮기지 않는다(사용자가 정함, 2026-11-28).
- 워크플로는 프로젝트의 기록이다(사용자가 정함: 프리셋만 전역). 다른 프로젝트의 것은 복사해 온다.

## 패키지

`@cs/workflow`(`packages/workflow`), 서비스 `ctx.csWorkflow`, 번들 행 `cs-workflow`. `csProject`를 주입받고 `csCatalog`는 있으면 쓴다(서버의 노드 정보로 필드를 추론하고 패치를 검증한다).

```
packages/workflow/src/
  types.ts        상태 조각, 읽기 연산의 답, 한도. 브라우저 절반이 타입으로 읽는다(지휘 세션)
  strings.ts      연산의 라벨(한국어)
  files.ts        파일 → 그래프, 정규화, 필드 추론과 검사. 순수 함수
  read.ts         읽기 연산의 답을 만드는 순수 함수
  reducer.ts      workflow 조각의 리듀서
  operations.ts   연산 아홉
  index.ts        서비스: 등록, 노드 정보 조회, 다른 컴포넌트에 주는 resolve
```

## 그래프는 블롭이다

그래프 JSON은 수십 KB가 된다. 기록의 `params`나 조각에 넣으면 상태(모든 기록과 조각이 통째로 브라우저에 간다)가 무거워진다. 그래서 그래프는 에셋 저장소에 JSON 파일로 넣고 기록과 조각에는 그 id만 둔다.

- 연산의 `execute`가 `context.importAsset(bytes, { mime: "application/json", name })`로 넣고, 그 id를 `outputs`가 아니라 `report`에 적는다. 출력이 아니므로 에셋 라이브러리에 뜨지 않는다.
- 읽을 때는 `ctx.csProject.assets().read(id)`다. 브라우저는 `/api/cs/asset?id=<id>`로 받는다(첨부로 온다).
- 저장하는 것은 정규화한 그래프다: `parseApiGraph`를 거친 뒤 노드 id 순(`compareNodeIds`), 열쇠 순으로 쓴 JSON. 같은 그래프는 같은 id가 된다.
- 화면에서 올리는 파일(JSON이나 PNG)은 먼저 `/api/cs/asset/stage`로 저장소에 넣고(라이브러리에 들어가지 않는다) 그 id를 `workflow.create`의 입력으로 준다.
- 그래프 파일은 5MiB까지다.

## 상태 조각

`ComponentStates.workflow`. 타입은 `@cs/workflow/types`에 있다(`WorkflowItem`, `WorkflowSlice`).

- 항목의 id는 만든 기록의 id다.
- 리듀서는 끝난(`done`) 기록만 본다. 만드는 기록(`create`, `save_variant`, `copy`)의 `report`(`WorkflowMadeReport`: 그래프 id, 필드, 노드 수, 이름, 설명)에서 항목을 만든다. 변형의 `parent`는 `params.workflow`이고, `create`의 기본 실행 자리는 `params.target`이다. `update`는 이름·설명·필드·기본 실행 자리를 고친다(필드는 `report.fields`에 검사를 거친 것이 있다). 지우면 항목을 빼고, 그것을 부모로 둔 변형의 `parent`는 `null`이 된다.
- 필드의 `options`(선택지)는 50개까지만 둔다. 넘으면 뺀다: 서버의 모델 파일 목록 같은 것을 기록에 싣지 않는다. 화면은 실행 폼을 그릴 때 서버에서 다시 읽는다(4-4).

## 연산

전부 `component: "workflow"`, `version: "1"`, `resource: "none"`, `deterministic: false`다.

| 연산 | `agent` | 입력 | 파라미터 | 하는 일 |
| --- | --- | --- | --- | --- |
| `workflow.create` | `none` | `file`(필수) | `name?`, `description?`, `target?` | 올린 파일에서 워크플로를 만든다. JSON(API 형식)이나 ComfyUI가 만든 PNG(`prompt` 청크)다. 이름이 없으면 파일 이름에서 확장자를 뺀 것이다 |
| `workflow.update` | `none` | — | `workflow`, `name?`, `description?`, `fields?`, `target?`(`null`이면 지운다) | 이름, 설명, 노출 필드, 기본 실행 자리를 고친다. 그래프는 고치지 않는다 |
| `workflow.save_variant` | `run` | — | `workflow`, `ops`, `name`, `description?` | 그래프 패치를 적용한 그래프를 새 워크플로(변형)로 남긴다. 원본은 그대로다 |
| `workflow.copy` | `none` | — | `project`, `workflow` | 다른 프로젝트의 워크플로를 이 프로젝트로 복사한다 |
| `workflow.delete` | `propose` | — | `workflow` | 워크플로를 지운다 |
| `workflow.list` | 읽기 | — | `q?` | 워크플로의 목록(id, 이름, 설명, 노드 수, 필드 수, 부모) |
| `workflow.get` | 읽기 | — | `workflow` | 이름, 설명, 필드(id, 라벨, 종류, 기본값, 범위, 선택지), 기본 실행 자리, 부모 |
| `workflow.graph` | 읽기 | — | `workflow`, `nodes?` | 그래프를 글로(노드 한 줄씩). 12000자를 넘으면 요약(종류별 노드 id)을 주고 `nodes`로 나눠 읽게 한다 |
| `workflow.check_patch` | 읽기 | — | `workflow`, `ops`, `target?` | 패치를 적용해 보고 새로 생긴 문제, 더하고 뺀 노드, 바뀐 노드의 글을 답한다. 아무것도 쓰지 않는다 |

`target`은 `{ provider, target }`(카탈로그 `graph` 항목의 열쇠)다.

규칙:

- **워크플로는 템플릿이다.** 그래프를 바꾸는 길은 그래프 패치뿐이고, 남기려면 변형을 새로 만든다. 그래프를 덮어쓰는 연산이 없다.
- `precondition`(기록 전 거절, `ProjectError`): 워크플로 id가 있는지(`invalid_params`), 이름(다듬어 1~100자)과 설명(2000자까지), 파일이 파싱되는지와 크기(`invalid_inputs`. UI 형식 JSON은 API 형식으로 내보내라고 알린다), 패치가 스키마에 맞고 적용되는지(`GraphPatchError`의 글과 몇째 연산인지), 구조 검사에서 패치가 새로 만든 오류가 없는지(`newProblems`), `fields`가 그래프에 묶이는지(`bindableParams`. 묶이지 않는 필드를 이름으로 짚는다)와 기본값이 종류에 맞는지(`coerceParamValue`), 필드는 100개까지.
- 서버의 노드 정보를 쓰는 검사는 `execute`와 `workflow.check_patch`에서 한다: 실행 자리(파라미터의 `target`, 없으면 워크플로의 기본 자리, 없으면 카탈로그의 `graph` 항목이 하나뿐일 때 그것)의 `nodeCatalog()`가 있으면 그것으로 종류·범위·연결을 검사하고 필드를 추론한다. 자리가 없거나 20초 안에 답하지 않으면 값만 보고 추론하고 구조 검사만 한다. `workflow.save_variant`가 여기서 새 오류를 만나면 기록은 `failed`(`OperationFailure`, 코드 `invalid_graph`)다. 경고는 `report.warnings`에 남는다.
- 새 워크플로의 필드는 `suggestParams(listInputCandidates(graph, 노드 정보))`다. 변형의 필드는 부모의 필드 가운데 여전히 묶이는 것(`rebaseParams`. 패치가 값을 준 필드는 기본값이 그 값이 된다)에, 패치가 더한 노드의 추천 필드를 더한 것이다.
- 미디어 필드(이미지·오디오·영상)의 기본값은 템플릿에 적힌 파일 이름일 뿐이다. 실행할 때 에셋으로 준다(2-3d).
- `workflow.copy`는 다른 프로젝트의 상태에서 항목을 읽고 그래프 블롭을 이 프로젝트의 저장소로 복사한다. 부모 관계와 기본 실행 자리는 가져오지 않는다.
- 연동 라이브러리가 내는 문장(패치 오류, 그래프 문제)은 한국어다(4-0에서 옮긴 그대로다). 도구 결과에 그대로 싣는다.

에이전트 요약(`agentSummary`): `workflows`(`[{id, name, description, fields}]`. 설명은 160자까지, `fields`는 필드 id의 목록, 30개까지. 넘으면 `workflows_more`에 남은 수). 워크플로가 없으면 칸을 넣지 않는다.

서비스 `ctx.csWorkflow`가 다른 기능 컴포넌트(생성, 2-3d)에 주는 것:

- `resolve(state, id)` → `{ item, graph }`(그래프는 블롭을 읽어 파싱한 것). 없으면 `ProjectError("invalid_params")`. 다른 컴포넌트는 조각을 직접 뒤지지 않는다.
- `objectInfo(target, signal?)` → 그 실행 자리의 노드 정보(`ObjectInfo`)나 `undefined`.

## 하지 않는 것

- 서버의 실행 기록에서 가져오기, 노드 검색과 설명, 준비 점검. 서버 조회 기능(4-4)이다.
- 그래프 패치의 제안 카드. 기존 앱의 "바로 생성"은 생성 연산에 패치를 주는 것(2-3d)이고 "워크플로로 저장"은 `workflow.save_variant`다.
- 워크플로 화면과 필드 편집기. 3-3이다.

## 고른 것

Claude가 고른 기본값이다.

| 고른 것 | 이유 | 뒤집으면 |
| --- | --- | --- |
| 그래프를 에셋 저장소의 블롭으로 둔다 | 상태가 가벼워진다. 같은 그래프는 한 번만 저장된다 | 기록의 `params`에 넣는다 |
| 파일에서 만들기, 필드 고치기, 복사는 사용자만 한다(`none`) | 에이전트는 파일을 올릴 수 없다. 기존 앱에서도 편집기는 사람의 것이었다 | `run` |
| 변형 저장은 에이전트가 바로 한다(`run`) | 기존 앱에서 승인 없이 했다. 원본을 건드리지 않고 실행 취소가 된다 | `propose` |
| 삭제는 제안이다 | 규칙 | — |
| 선택지가 50개를 넘는 필드는 선택지를 싣지 않는다 | 서버의 모델 목록이 기록에 박히지 않는다 | 한도를 바꾼다 |
| 워크플로의 이름은 겹쳐도 된다 | id로 가리킨다. 복사와 변형이 이름 때문에 막히지 않는다 | `precondition`에서 거절 |

## 일의 나눔

| 묶음 | 파일 | 누가 |
| --- | --- | --- |
| 계약: 타입, 패키지 틀, 번들 | `packages/workflow/src/types.ts`, `strings.ts`, `package.json`, `packages/bundle/**` | 지휘 세션 |
| 순수 로직: 파일, 읽기, 리듀서 | `files.ts`, `read.ts`, `reducer.ts`와 시험 | 서브 에이전트(표준) |
| 연산과 서비스 | `operations.ts`, `index.ts`와 시험 | 서브 에이전트(표준) |
| 조합 시험, 문서 | `tests/integration/workflow.test.ts`, `docs/**` | 지휘 세션 |

## 완료 기준

- `pnpm check`와 `pnpm test:integration`이 통과한다.
- 단위 시험: 파일에서 만들기(JSON, PNG, UI 형식, 틀린 파일, 큰 파일), 정규화(같은 그래프는 같은 바이트), 리듀서, 변형(부모는 그대로, 필드의 승계), 삭제와 부모 끊기, 복사, 읽기 넷, `precondition`의 거절마다, 노드 정보가 있을 때와 없을 때.
- 조합 시험: 페이지에서 그래프 파일을 올려 워크플로를 만든다 → 상태에 뜬다 → 가짜 LLM이 `cs_workflow_graph`로 읽고 `cs_workflow_save_variant`를 부른다 → 변형이 생기고 원본의 그래프 id는 그대로다 → `cs_workflow_delete`는 제안으로 남는다.

## 결과

2026-11-29에 끝났다. 계약(조각, 연산 아홉, 서비스의 `resolve`·`objectInfo`)은 위 그대로다.

확인한 것:

- `pnpm check` 통과(단위 시험 1060개. 이 갈래의 것은 `packages/workflow` 147개).
- `pnpm test:integration` 통과(28개). 새 시험 `tests/integration/workflow.test.ts`가 실제 dsh에서 본다: 로그인한 페이지가 그래프 JSON을 올리고(stage) `workflow.create`를 실행한다 → 조각에 워크플로가 뜨고(이름은 파일 이름, 필드는 그래프에서 추천한 것) 에셋 라이브러리는 비어 있다 → 가짜 LLM이 `cs_workflow_graph`로 그래프를 글로 읽는다 → `cs_workflow_save_variant`로 패치한 그래프를 변형으로 남긴다(원본의 그래프 id는 그대로다) → `cs_workflow_delete`는 제안으로 남는다. 모델이 받는 도구에 `cs_workflow_create`·`_update`·`_copy`가 없다.
- 노드 정보(`nodeCatalog`)를 쓰는 길은 단위 시험의 가짜 생성 프로바이더로만 봤다. 실제 서버로는 보지 못했다(**미확인**. 생성 프로바이더는 4-2다). 실제 모델로도 돌려 보지 않았다(**미확인**).

구현하며 더 정한 것(Claude가 고른 기본값):

- 패치가 적용되지 않을 때의 문장은 `op <n>: <연동 라이브러리의 문장>`이다(라이브러리가 앞에 붙이는 `연산 <n>: `은 뗀다).
- 필드의 id는 `<노드>.<입력>`이어야 한다. 이름과 설명의 길이는 코드 포인트로 센다.
- 변형의 추천 필드는 패치가 더한 노드에서만 뽑는다. 이미 있는 필드(id)는 건너뛴다.
- `workflow.graph`는 줄 경계에서 자르고 마지막 줄에 남은 노드 수를 적는다. `nodes`로 걸러도 길면 같은 식으로 자른다.
- `workflow.save_variant`와 `workflow.check_patch`의 도구 결과는 파라미터(`ops`)를 되풀이하지 않는다(`omitParamsFromResult`).
- 부모가 조각에 없는 변형 기록은 `parent: null`로 들어온다.
- 카탈로그에 `graph` 항목이 둘 이상이고 실행 자리를 주지 않으면 노드 정보 없이 구조 검사만 한다.

## 리뷰에서 고친 것

구현과 독립된 리뷰가 찾은 것이다(2026-11-29).

| 찾은 것 | 고친 것 |
| --- | --- |
| 노드 제목이 길면(라벨이 100자를 넘는다) 만들기나 변형 저장이 `done`으로 끝나고도 워크플로가 조각에 나타나지 않는다. 리듀서는 필드가 스키마에 맞을 때만 받는데 쓰는 쪽이 그것을 지키지 않았다 | 저장하는 필드는 늘 스키마에 맞는다: 라벨을 자르고, 맞지 않는 선택지·범위를 빼고, 그래도 맞지 않는 필드는 뺀다 |
| 노드 정보를 기다리는 동안(20초까지) 중지해도 연산이 이어져 `done`으로 끝난다 | 기다린 뒤 신호를 확인한다. 기록은 `cancelled`로 끝난다 |
| `constructor` 같은 id로 읽으면 엉뚱한 답이 나오고 삭제 제안이 써진다. 그런 이름의 노드를 고치는 패치는 `TypeError`로 새어 나간다 | 조각과 그래프를 자기 열쇠로만 찾는다. 패치의 뜻밖의 오류는 `invalid_params`로 거절한다 |
| 패치가 필드에 맞지 않는 값(시드 -1, 글 필드에 숫자)을 주면 변형이 그 값을 기본값으로 갖는다 | 패치가 값을 준 필드의 기본값을 종류에 맞는지 검사하고 거절한다 |
| 아주 깊게 겹친 JSON이 스택을 넘쳐 `RangeError`가 새어 나간다 | `invalid_inputs`로 거절한다 |
| `workflow.update`의 기록에 화면이 보낸 필드가 그대로 남아 큰 선택지 목록이 기록에 실린다 | 선택지가 50개를 넘는 필드와 2만 자를 넘는 기본값은 거절한다(화면은 선택지를 빼고 보낸다) |
| 요약이 잘리면 "더 적게 달라"고 하는데 요약에는 거를 것이 없다. 한 줄을 자를 때 서로게이트가 갈린다. 없는 노드만 고르면 빈 글이 온다. 에이전트 요약이 워크플로마다 필드 id를 100개까지 싣는다 | 문장을 고치고 코드 포인트로 자른다. 요약의 필드 id는 30개까지다(`fields_more`) |
| 복사의 사전 조건이 있는지만 보려고 그래프 블롭을 통째로 읽는다 | 저장소에 있는지만 묻는다 |
| 패치가 노드를 전부 지우면 빈 그래프가 변형으로 저장되고 그 뒤로는 읽지 못한다(템플릿에 출력 노드가 없었으면 새 문제로 잡히지 않는다. 리뷰 봇이 찾았다) | 노드가 남지 않는 패치를 거절한다 |

사용자가 정할 것으로 남긴 것:

- **에이전트가 사용자의 단계를 실행 취소한 뒤 새 변경으로 그 단계를 버릴 수 있다.** 2-3a의 가드는 `propose`·`none` 연산의 단계만 막는다. 사용자가 화면에서 만든 변형(`run` 연산의 단계)은 에이전트가 `cs_proj_undo`로 되돌릴 수 있고, 이어서 다른 변경을 쓰면 그 단계는 히스토리에서 버려진다. 지금은 규칙 절의 문장("새 변경은 뒤의 단계를 버리니 먼저 묻는다")만 막는다. 에이전트의 실행 취소를 자기 단계로만 좁힐지는 프로젝트 계층 전체의 결정이다.
