# @cs/project module contracts

Ported from DreamVerse `packages/dv/project` at commit `ec0ac62760` (MIT); see `THIRD_PARTY_NOTICES.md` at the repository root.

This file specifies the internal modules of the `csProject` service: what each one does, its rules and errors, and the unit tests that pin it. The public types are in `src/types.ts`, which is also the client face `@cs/project/types` and imports no host module, and in `src/operation-types.ts` (`OperationSpec` and `OperationToolCall`, which use DSH tool types); the error codes in `src/shared.ts`, and the service surface with its JSDoc (the history list and its current position, lock scope, every method) in `src/index.ts`.

## Contents

1. [Modules, files and tests](#1-modules-files-and-tests)
2. [Module calls](#2-module-calls)
3. [Rules for every module](#3-rules-for-every-module)
4. [Record store](#4-record-store-record-storets)
5. [Subscriptions](#5-subscriptions-subscriptionsts)
6. [Reducer registry and state](#6-reducer-registry-and-state-reducersts)
7. [History](#7-history-historyts)
8. [Runner](#8-runner-runnerts)
9. [Scheduler](#9-scheduler-schedulerts)
10. [Chat sessions, agent tools and agent context](#10-chat-sessions-agent-tools-and-agent-context-sessionsts-agent-toolsts-proj-toolsts-agent-contextts-project-updatests)
11. [Test plan](#11-test-plan)

## 1. Modules, files and tests

| Module                          | Files                                                                                | Tests                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Record store and subscriptions  | `src/record-store.ts`, `src/subscriptions.ts`                                        | `src/record-store.test.ts`, `src/subscriptions.test.ts` |
| Runner and scheduler            | `src/runner.ts`, `src/scheduler.ts`                                                  | `src/runner.test.ts`, `src/scheduler.test.ts`           |
| History and reducer registry    | `src/history.ts`, `src/reducers.ts`                                                  | `src/history.test.ts`, `src/reducers.test.ts`           |
| Sessions, tools, agent context  | `src/sessions.ts`, `src/agent-tools.ts`, `src/proj-tools.ts`, `src/agent-context.ts` | `src/agent-tools.test.ts`, `src/proj-tools.test.ts`     |
| Project messages                | `src/project-updates.ts`                                                             | `src/project-updates.test.ts`, `src/project-updates-listener.test.ts` |
| Project folders                 | `src/folders.ts`                                                                     | `src/folders.test.ts`, `src/proj-tools.test.ts`         |

The runner and history call the record store; the runner calls the reducer registry and the scheduler; the reducer registry calls `store.ancestors`; the runner calls `history.discardedSteps`. Tests use the real modules (`src/testing/support.ts` `startModules()`), not mocks of other modules. Run them from the repository root: `pnpm exec vitest run --project unit packages/project`.

## 2. Module calls

```
  callers (API, agent tools, components)
        |
        v
  index.ts  CsProject (csProject) ---------------------------------------------+
        |  createProject renameProject removeProject openProject listProjects  |
        |  newProjectFolder                                -> folders          |
        |  getRecord                                       -> record-store     |
        |  run acceptStale registerOperation listOperations                    |
        |                                                  -> runner           |
        |  undo redo listHistory                            -> history          |
        |  getState registerReducer registerReferenceKind  -> reducers         |
        |  wait                                            -> scheduler        |
        |  subscribe                                       -> subscriptions    |
        |  sessionProject                                  -> folders          |
        |  holdToolCalls                                   -> sessions         |
        |  registerOperation (tool), parseInputs, parseReference               |
        |                                                  -> agent-tools      |
        |  cs_proj_* tools (registry mounted)              -> proj-tools       |
        |  cs:project section (systemPrompt mounted)       -> agent-context    |
        |  agent/pre-step listener, csProjectSight projection                  |
        |    (sessionProjections mounted)                  -> project-updates  |
        |  registerAssetStore: the store the runner and agent-tools read       |
        v                                                                      |
  runner ----> store.line / append                                            |
    |    ----> reducers.stateAt / getState / assetsOf                          |
    |    ----> scheduler.enqueue / cancel scheduler ----> runner.execute       |
    |    ----> asset store                                                     |
    v                                                                          |
  runner ----> history.discardedSteps                                         |
  history, reducers, runner, scheduler ----> record-store                     |
                                                         |                     |
                                                         v  onChange(event)    |
                                         subscriptions.emit, scheduler.recordFinished
```

Only `record-store.ts` reads or writes the files in a project's `.comfy-studio/` directory, and only `folders.ts` writes the DSH Workspace registry (`create`, `setTitle`, `attachSession`, `delete`) and makes folders in the projects folder (`newFolder`: a non-recursive `mkdir` of `<name>`, then `<name> 2`, `<name> 3`, … on `EEXIST`, with path separators in the name replaced by `-`; `invalid_params` for an empty name). The service resolves the projects folder when it starts: the absolute `Config.projectsFolder` (`CS_PROJECTS_FOLDER`), else `<home>/comfy-studio-projects` (`DEFAULT_PROJECTS_FOLDER` in `src/index.ts`, in the OS home directory); it fails to start only when that home directory does not resolve to an absolute path or the configured folder is relative, with an error that names `CS_PROJECTS_FOLDER`. The runner's scratch directory for `execute` is the one other file system use (a temporary directory under the OS temp directory).

## 3. Rules for every module

**Lock.** `RecordStore.lock(project, fn)` serializes work per project. Who holds it:

- `run`: while it checks the request and appends the operation record; again for each update line (`running`, the final status). Never while `execute` runs.
- `undo`, `redo`, the `forget` of `removeProject`, the `proj.create` append of `createProject`, and `acceptStale`: for the whole call (`index.ts` takes it for all but `acceptStale`, which the runner takes).
- Reads (`getState`, `getRecord`, `listHistory`, `openProject`, `listProjects`) take no lock. Read-only operations take no lock.
- The lock is not reentrant: a function that runs under the lock never calls `lock` for the same project. Module functions documented "the caller holds the project lock" never take it themselves.

**Errors.** Throw `ProjectError(code, message)` from `src/shared.ts` with one of the approved codes. Messages are in words a creator can read and name the project or record. A refused call changes nothing on disk and emits no event. Failures of an operation call after its record exists never throw: they end the record with a `RecordFailure` (`operation_failed`, `input_failed`, `stopped`).

**IDs and times.** Record IDs are `randomUUID()` values; a project ID is the ID of the project's DSH Workspace. Times are `new Date().toISOString()`.

**Record templates.** Every record has `kind: 'operation'` and copies the six `RecordOrigin` fields from the call: `session`, `turn` and `tool_call` link the record to the DSH session log, and `intent` is the agent's `reason` or a description of the human's gesture. A record whose run request carries `started_by: {record, slot, lane?}` stores it as given; a record without it was not started by a record. `proj.*` records are written with `status: 'done'` and have no update lines.

| Record               | `kind`      | `component` | `operation`, `operation_version` | `params`                                                         |
| -------------------- | ----------- | ----------- | -------------------------------- | ---------------------------------------------------------------- |
| `proj.create`        | `operation` | `proj`      | `proj.create`, `1`               | `{title}`                                                        |
| `proj.stale_accept`  | `operation` | `proj`      | `proj.stale_accept`, `1`         | `{record}`                                                       |

All of them have `inputs: []`, `outputs: []`, `based_on: null`, `supersedes: []`, `deterministic: true`.

**Current form.** Every module reads records in their current form from the record store: the record line, with each update line applied in order, and with the `resolved_asset` of each `{record, output}` input filled from the producer's `outputs[output]` once the producer is `done` (a derived value, never written to disk).

## 4. Record store (`record-store.ts`)

Owner: agent A. The store's files live in the `.comfy-studio/` directory (`PROJECT_DIR` of `@cs/project/folder`) of the project folder that `folders.get(project).path` names; the store writes nothing else in the folder. Files: `records.jsonl` (one JSON object per line), `line.json` (`ProjectLine` `{tip, at}` as one line, rewritten atomically). `tip` is the last step: the history list is the `parents[0]` ancestry of `tip`. `at` is the current position, a record of the history list. Each record's parent is `at` when the record is written. The store reads a project at the first call that names it and takes the last record as `tip` and `at` when `line.json` is missing.

| Function                                  | Behavior                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constructor(folders, onChange)`          | Stores both. `folders.get(project)` gives the project's `ProjectInfo` and throws `unknown_project`; `folders.list()` lists every project.                                                                |
| `lock(project, fn)`                       | A per-project promise chain: `fn` starts after every earlier `fn` for that project settled, whether it resolved or threw. Different projects run concurrently. Returns `fn`'s result or rejection.      |
| `createProject(project, dir)`             | Creates `dir` when missing and starts the project in memory with no record; `records.jsonl` appears with the first `append`. Refuses a `dir` that has `records.jsonl` with `invalid_params`.            |
| `listProjects()` / `getProject(id)`       | `folders.list()` and `folders.get(id)`.                                                                                                                                                                 |
| `forget(project)`                         | Drops the project from memory; its files stay, and a later call reads it again.                                                                                                                        |
| `append(project, line)`                   | Rules in the JSDoc: `parents` must be `[at]` (`[]` for the first record), else `parent_not_head`. Assigns `id` and `created_at`, appends one line, sets `tip` and `at` to the record, then emits `record` and `line`. |
| `appendOutsideHistory(project, line)`     | The parent rule of `append`; appends one line and emits `record`, but keeps `tip`, `at` and `line.json` unchanged, so the record joins no history list and discards nothing. |
| `update(project, update)`                 | Rules in the JSDoc. Appends one `{"update": id, …}` line, applies it in memory, emits `{kind: 'update', record}` with the current form.                                                                 |
| `getRecord` / `listRecords` / `ancestors` | Current forms. `listRecords(project, keep?)` returns the records that `keep` accepts, in write order. `ancestors` follows `parents[0]` only (the raw chain).                                           |
| `line(project)`                           | The project's `{tip, at}`, or undefined for a project without records.                                                                                                                                  |
| `requireLine(project)`                    | The project's `{tip, at}`; `invalid_params` for a project without records.                                                                                                                              |
| `lineIds(project)`                        | `{ids, atIndex}`: the record IDs of the history list, oldest first, and the index of `at`; copies no record. `{ids: [], atIndex: -1}` for a project without records.                                     |
| `moveTo(project, at)`                     | Sets `at` and rewrites `line.json`; `tip` stays. Writes no record; emits `{kind: 'line', tip, at}`. `unknown_record` for an unknown record. The caller checks that `at` is in the history list.         |

Invariants:

- `records.jsonl` is append-only: no function rewrites or truncates it. Line order is write order.
- A record line is written exactly once; it carries no `started_at`, `finished_at`, `error`, `cost` or `report`.
- Status order: `pending` → `running` | `done` | `failed` | `cancelled`; `running` → `done` | `failed` | `cancelled`. Moving to the same status or backwards throws `status_backwards`; any update of a `done`, `failed` or `cancelled` record throws `record_finished`.
- The store emits an event only after the line or file is written; a refused call emits nothing.
- No function removes or reorders a record; only `append` and `moveTo` change `tip` and `at`.
- `getRecord` and `listRecords` return copies, so a caller that mutates a result cannot change the store.

**Project folders (`folders.ts`).** A project is a registered DSH Workspace whose folder holds `.comfy-studio/records.jsonl`; `list` filters the registry by that file (oldest `createdAt` first, then ID) and `get` throws `unknown_project` for any other ID. `create(folder, title, writeFirst)`, `rename` and `remove` run one at a time in call order. `create` resolves the folder's `realpath`, reuses the Workspace that has the path or registers one, sets the title when this call registered the Workspace or the folder has no `records.jsonl`, then calls `writeFirst` (the service's `proj.create` append under the project lock) when `records.jsonl` is missing, and attaches every stored (`sessionPersistence`) or live (`sessions`) top-level chat session whose header cwd resolves to the folder; an attach that fails is logged and the next one runs. `rename` sets the first free title among the other projects' titles; `remove` deletes the registration only.

## 5. Subscriptions (`subscriptions.ts`)

Owner: agent A. `subscribe(project, listener)` adds a listener and returns an idempotent remover. `emit(project, event)` calls the project's listeners synchronously, in subscription order, on a snapshot of the set (a listener removed during delivery still receives the current event; one added during delivery does not). A throwing listener is reported to `onListenerError` and delivery continues. `csProject.subscribe` exposes it; the live stream (`/cs/events`) and the stream service are its consumers.

## 6. Reducer registry and state (`reducers.ts`)

Owner: agent D.

| Function                             | Behavior                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register(key, reducer)`             | One reducer per key (`reducer_exists`). Registration order is the call order of `reduce`. Returns a remover.                                           |
| `registerKind(spec)`                 | One owner per reference kind (`kind_exists`). `listReferenceKinds()` returns registration order. Returns a remover.                                    |
| `kindsWithVersion(state, id, n)`     | The kinds whose `createdBy(owner slice, id, n)` is not null, in registration order.                                                                    |
| `kindsWithId(state, id)`             | The kinds whose `latest(owner slice, id)` is not null, in registration order.                                                                          |
| `latestVersion(state, kind, id)`     | `latest` of the kind on its owner's slice; null for a kind that is not registered or an owner without a reducer.                                       |
| `getState(project)`                  | `stateAt(project, at)` with the project's current position.                                                                                            |
| `stateAt(project, head)`             | `reduceChain(info, store.ancestors(project, head), <every record of an outsideHistory operation, in write order>)`.                                    |
| `reduceChain(info, records, outside)` | Starts each registered reducer at `initial()`, calls `reduce` for every record in order, then for each `outside` record only the reducer of its component, returns `{project: info, head: last.id, components}`. |
| `apply(state, record)`               | One more `reduce` per reducer on a copy of `state.components`; `head` becomes `record.id`.                                                             |
| `assetsOf(state, ref)`               | `assetsOf` of the ref's kind, on its owner's slice; null for another ref, a kind that is not registered, or an owner without a reducer.                |
| `createdBy` (private)                | `createdBy` of the ref's kind, on its owner's slice before the record; the `proj` slice reads it while it reduces that record.                         |
| `agentSummaries(state, assets, s)`   | The `agentSummary(slice, assets, state, s)` fields of each reducer that has one, for session `s`: `proj` first, then the other keys alphabetically.    |

`projReducer` (Project's own slice) follows its JSDoc. Staleness in detail, for each record R in order:

The producers of an input are the record in `created_by[resolved_asset]`, for a `{record, output}` ref also the record it names (a later record may have output the same asset again and taken the `created_by` entry) and, for a version ref, the record that created that version (`createdBy` of its kind; none while the kind is not registered).

1. Each output asset of R when R is `done`: `created_by[asset] = R.id`.
2. Each ID X in `R.supersedes`: `superseded[X] = R.id`; then every earlier record with an input produced by X, or by a record already stale through X, gets `stale[consumer] = R.id` unless it carries a stale acceptance.
3. Each input of R produced by a record P with `superseded[P]` or `stale[P]` set: R gets `stale[R] = superseded[P] ?? stale[P]`, unless R carries a stale acceptance.
4. `proj.stale_accept` with `params.record = X`: delete `stale[X]` and remember X as accepted; accepted records are never marked again, and their consumers are not stale through them.

Version staleness follows from these rules: the operation that writes a new version of a reference kind supersedes the record that created the previous version (`OperationSpec.supersedes`), so every record that read the previous version, and every record downstream of it, is stale.

Invariants: reducers are pure; `getState` on the same records always gives equal state; a reducer never sees a record twice; a registered reducer that throws makes `getState` throw (the error propagates; nothing is cached). An implementation may cache states by `(project, head)`; a cached state must be dropped when an update line changes a record on that chain.

## 7. History (`history.ts`)

Owner: agent D. The module comment defines the history list, the current position and moves; the JSDoc of `discardedSteps`, `undo`, `redo`, `moveTo` and `list` defines their behavior.

- The history list is the `parents[0]` ancestry of `tip` (`store.lineIds`), oldest first; the first record is `proj.create`.
- `undo(project)`: moves `at` to its parent; `nothing_to_undo` at the first record; `invalid_params` for a project without records.
- `redo(project)`: moves `at` to the next record of the history list toward `tip`; `nothing_to_redo` at `tip`.
- `moveTo(project, to)`: `unknown_record` for an unknown ID; `invalid_params` for a record outside the history list (a discarded record); a move to `at` changes nothing and emits no event; otherwise `at` becomes `to`, before or after the old `at`.
- `discardedSteps(store, project)`: the records of the history list after `at`, oldest first; empty when `at` is `tip`.
- `list(query)`: the steps of the history list, newest first, as `{record, place}`, where `place` is `before`, `current` or `after` relative to `at`; filters combine with AND; `before` keeps the steps before that record in the list (`unknown_record` when the list does not have it); `records` keeps the named records; `tool_call` keeps the records one tool call wrote; `limit` applies after every filter; only the listed entries are copied.

`csProject.undo(project)`, `csProject.moveTo(project, to)` and `csProject.redo(project)` call `undo`, `moveTo` and `redo`; each holds the project lock and returns `{tip, at}`. `csProject.line(project)` returns `{tip, at}`; `csProject.listRecords(project)` returns every record, discarded records included.

Invariants: a move writes no record and keeps `tip`; an undo and then a redo return to the same position; a write after a move appends after `at`, so the steps that were after `at` leave the history list and stay in `records.jsonl`; a discarded step never comes back to the list.

## 8. Runner (`runner.ts`)

Owner: agent B.

**Registration.** `registerComponent(key)` adds a component key and returns the disposer that removes it; a registered key is refused with `component_exists`. The service registers `proj` when it starts, and its `registerReducer` and `registerReferenceKind` refuse a key that is not registered with `invalid_params`; `registerReferenceKind` also refuses the kinds `asset`, `record` and `version`, the keys of the other input reference arms, with `invalid_params`, and it and its remover rebuild every operation tool, because the `inputs` text lists the kinds. `registerOperation(spec)` accepts an operation of a registered component: refuse a registered name with `operation_exists`, a `component` that no plugin registered with `invalid_params`, and a name that does not start with `<component>.` with `invalid_params`. `listOperations` returns registration order.

**Runner: run.** Steps of `run(request)`:

1. Look up the operation (`unknown_operation`) and the project (`unknown_project`).
2. Validate `params` with `validateArgs(spec.params, params)` from `@deepseek-ai/dsh-tools`; any message → `invalid_params` with the messages joined. Every input role must be a key of `spec.inputs` (`invalid_inputs`).
3. Read-only operation (`spec.readOnly`): state = `reducers.getState(project)`, resolve inputs (step 5 rules), await `spec.precondition?.(request, state)` (a throw rejects `run` with that error), call `execute` with `record: null` and a scratch directory, and resolve `{record: null, outputs, report: report ?? null}`. No lock, no record. A throw from `execute` rejects `run` with that error.
4. Take the lock. `parent` = the current position, `store.line(project).at`.
5. Resolve inputs against `reducers.getState(project)` (the state at `parent`): `{asset}` must exist in the registered asset store (`unknown_asset`); `{record, output}` must name an existing record (`unknown_record`) and a non-negative integer `output`; when the producer is `done`, `resolved_asset` is its `outputs[output]` (missing → `invalid_inputs`); `failed` or `cancelled` → `invalid_inputs`; `pending` or `running` → `resolved_asset: null`, allowed only when `request.after` is set, else `input_not_ready`. An input whose role is in `spec.pendingInputRoles` resolves to `resolved_asset: null` for a producer in any status other than `done`, without `request.after`. A version ref becomes one input per asset of `reducers.assetsOf` (null → `invalid_inputs`), each with the same role and ref. Then await `spec.precondition?.(request, current state)` under the lock: a throw rejects `run` with that error unchanged, before anything is written.
6. Append the operation record by the discard rule (below): `status: 'pending'`, `component`, `operation`, `operation_version`, `deterministic` from the spec, `based_on ?? null`, `outputs: []`, and `supersedes`: `request.supersedes ?? []` followed by `spec.supersedes?.(params, current state)`, without repeats, and `request.started_by` when the request has it (copied, never read). A `spec.outsideHistory` operation appends with `store.appendOutsideHistory` instead: `tip` and `at` stay, and nothing is discarded or cancelled. Release the lock.
7. `request.after` set → `scheduler.enqueue(project, id, spec.resource, after, spec.pendingInputRoles ?? [])`; resolve with the `pending` record, `outputs: []`, `report: null`. Otherwise `final = await execute(project, id, request.signal)`; resolve with `{record: final, outputs: final.outputs, report: final.report ?? null}`. Immediate runs do not count against the scheduler's limits.

**Runner: execute.** `execute(project, record, signal?)`:

1. Read the record; a record that a write discarded before it started ends `cancelled` / `discarded` at once. Its operation must still be registered, else the final update is `failed` / `operation_failed`.
2. An input with `resolved_asset: null` (a producer that did not finish `done`) whose role is not in `spec.pendingInputRoles` → `failed` / `input_failed`. Inputs of those roles reach `execute` with `resolved_asset: null`; the record's current form fills it once the producer is done.
3. Deterministic reuse: when `spec.deterministic` and an earlier record has the same `operation` and `operation_version`, status `done`, `cost.reused` not true, equal params (canonical JSON with sorted keys) and the same `resolved_asset` values by role (the roles compared in sorted order, the assets of one role in the order the call gave them, so the same assets in other roles or in another order are another call): one update `{status: 'done', finished_at, outputs: <its outputs>, cost: {wall_seconds: 0, reused: true}}`.
4. Otherwise update `{status: 'running', started_at}`; compute `state = reducers.stateAt(project, record.parents[0])`; create a scratch directory (`mkdtemp(join(tmpdir(), 'cs-operation-'))`); call `spec.execute(context)` with `importAsset` bound to `assets.importAsset(source, meta, record.id)`.
5. Success → `{status: 'done', finished_at, outputs, cost: {wall_seconds: <measured, rounded to ms>, reused: false}, report}` (omit `report` when undefined). A throw while `signal` is aborted → `cancelled` / `stopped`, or `cancelled` / `discarded` when a discard aborted it; any other throw → `failed` with the error's message and the code `operation_failed`, or the code of a thrown `OperationFailure(code, message)` (`src/shared.ts`; the code is lower-case words joined by `_` and none of the runner's own `operation_failed`, `input_failed`, `stopped`, `discarded`, else the constructor throws `TypeError`). An operation uses it for a failure that reducers and views must tell apart without reading the message, such as a generation that its server refused before queuing it. Remove the scratch directory in every case.

**`acceptStale`.** Under the lock: the record must exist (`unknown_record`); append `proj.stale_accept` with `parents: [at]` by the discard rule.

**Discard.** Every record the runner appends goes after `at` and becomes `tip` and `at` (`appendStep`). The records of the history list that were after `at` leave the list. Each of them that is `pending` or `running` ends `cancelled` with `error {code: 'discarded'}`: an executing record is aborted; a queued scheduled record leaves the queue through `scheduler.cancel` and is updated at once; a record that has not started yet ends when `execute` starts it.

**`recover`.** At start: under each project's lock, every `pending` or `running` operation record gets `{status: 'cancelled', finished_at, error: {code: 'stopped', message: 'The server stopped before the call finished.'}}`.

Invariants: every record the runner writes starts `pending` and ends with exactly one final update; `run` never leaves a record `running` after it resolves (except a scheduled one, which the scheduler finishes); the lock is never held across `await` of `execute`.

## 9. Scheduler (`scheduler.ts`)

Owner: agent B. Behavior is in the module comment and JSDoc. Details:

- Queue order is enqueue order across projects. Each pump walks the queue once, front to back: a ready record with room starts; a ready record without room stays in place (later `none` records may still start); a waiting record stays.
- Readiness reads current forms from the store. `input_failed` updates are written under the project lock.
- The producers of inputs whose role is in the operation's `pendingInputRoles` are not dependencies: the record neither waits for them nor fails when they fail.
- `wait(project)` without records also waits for records enqueued while it waits, until the project has none queued or running. `wait(project, records)` works for any record, scheduled or not, and resolves at once when all are finished.
- `cancel(project, record)` takes a queued record that has not started out of the queue and returns whether it was queued; the caller ends the record. Waiters and dependent records re-check after that update.
- `dispose` stops starting records; a `wait` that can no longer settle stays pending (the service is going away).

Invariants: never more than `limits.gpu` scheduled `gpu` records and `limits.cpu` scheduled `cpu` records run at once; a record never starts before its dependencies are `done`; each queued record runs at most once.

## 10. Chat sessions, agent tools and agent context (`sessions.ts`, `agent-tools.ts`, `proj-tools.ts`, `agent-context.ts`, `project-updates.ts`)

**Sessions.** `hold(session, work)` chains `work` behind earlier held work; `ready(session)` settles after all of it, whether it fulfilled or rejected.

**Turn.** `turnOf(ctx, exec)` reads the turn of a tool call from DSH: the `lastTurn` that the DSH agent registry reports for the calling agent's session (`ctx.get('agents')?.turnBoundaryOf(session).lastTurn`), as a string `TurnId` such as `"3"`, unique within the session. A call without an agent, without the `agents` registry, or before the session's first turn has turn `null`. Operation tools and `cs_proj_*` tools both use it.

**Asset store.** `registerAssetStore(store)` keeps one store; a later registration replaces it and the remover clears only the same store. While no store is registered, the service uses an empty store (`EMPTY_ASSET_STORE` in `src/index.ts`): `has` is false, `get`, `read` and `url` throw `unknown_asset`, and `importAsset` throws "No asset store is registered with csProject, so the project cannot hold assets yet.", so a run that names an asset input or imports an output fails. `assets()` returns a reader (`has`, `get`, `read`, `url` only) over the store in use (the registered one, else the empty one) for callers outside the project layer; the view API (`@cs/api`) reads asset entries through it. It offers no import, so an asset still enters a project through an operation run only. `parseInputs` looks a role up among the operation's own input keys, so a role named like an `Object.prototype` member is an unknown role.

**Agent tools.** While the DSH `tools` registry is mounted, the service registers one tool per registered operation and removes it with the operation or the registry. `toolNameOf(spec)`: `cs_<name with _>`. The tool's description is `<description>`, then "Uses the GPU." for resource `gpu` or "Runs on the CPU." for `cpu` (nothing for `none`), then "A read that writes no record." for `readOnly` or, for `deterministic`, "Repeating a call with the same inputs and params reuses the earlier result.". Its parameters are `spec.params`, `spec.toolParams`, and the shared `reason` (required), `inputs` (when the operation has input roles; its text names `<id>@<version>` with `listReferenceKinds()` while a kind is registered, and says that `cs_proj_state` lists the IDs; it names no example ID), and `supersedes` and `based_on` (when the operation writes a record). A call:

1. waits for `sessions.ready(session)`; `session` is the calling agent's ID, else `anonymous`;
2. takes the session's project, else fails with "This conversation has no project yet: call cs_proj_create first.";
3. builds the origin: actor `agent`, surface `chat`, the session, `turnOf(ctx, exec)`, the call ID, and the `reason` (empty → the operation name) as the intent;
4. reads the project's current state and parses `inputs` with `parseInputs`;
5. builds the run request: params are the arguments without the shared and tool-only ones, and an argument outside `spec.params` fails with `invalid_params` ("<tool> has no argument <names>.") before anything is written; `based_on` and `supersedes` from the arguments;
6. calls `spec.prepareToolCall` with `{args, request, state, exec}`, which may refuse the call before any record or change the request's params and inputs;
7. schedules the call (`after: []`) when an input outside the operation's `pendingInputRoles` names an unfinished record, then runs it;
8. returns `{record, status, summary, outputs [{role, asset_id, mime, url}], scheduled, params, report?, images?}`; a read returns `record: ''`, the summary `<tool> answered` and its report; a `failed` or `cancelled` record is a tool error (`stopped` → "<tool> was stopped before it finished.", else the failure message). Model-visible text names the tool (`toolNameOf(spec)`), never the operation. `formatToolResult` (internal) writes the value as one text block, then one image block per image attachment; the text block has the `params:` line unless `spec.omitParamsFromResult` is true.

**Input references.** `parseInputs(spec, raw, state, kinds, callerName)`: `raw` is an object of role → reference text or a list of them, each parsed by `parseInputRef` (`csProject.parseReference`). `<record>#<output>` → `{record, output}`; `<id>@<version>` → `{<kind>: id, version}` for the one kind of `kindsWithVersion`, else `invalid_inputs` ("Unknown version …; reference kinds: …" or "… names more than one reference kind: …"); anything else → `{asset}`. An unknown role, a list on a single role, a non-string reference and a missing required role throw an error that names the role and `callerName`: the agent tool passes the tool name (`cs_shot_render`), and `csProject.parseInputs(operation, raw, state, callerName?)` passes the operation name unless its caller names another, so `@cs/api` names the operation. `formatInputRef(ref)` writes a reference as the text this parser reads back, and `versionRefOf(ref)` gives the kind, ID and version of a version ref.

**Project tools.** While the registry is mounted, the service also registers the `cs_proj_*` tools of `proj-tools.ts` and removes them with the registry. No tool takes a project argument. Each works on the session's project (else "This conversation has no project yet: call cs_proj_create first.") and writes its records with the agent origin of the call. `cs_proj_create` makes the session's working directory a project (`createProject(cwd, title, origin)`; "This conversation has no folder to make a project in." for a session that is not live in `sessions`) and refuses ("This conversation's folder is already the project "<title>"; keep all work in it. Start a new conversation for a new project.") when the session's folder is a project. `sessionProject(session)` reads the live session's `header.cwd`, takes its `realpath`, and returns the project whose Workspace path equals it (`workspaceOfSession` of `@cs/project/folder`), else null. `cs_proj_history_list` returns `listHistory` entries (default limit 20), each as `{record, place, operation, status, actor, intent, outputs}`. `cs_proj_undo` takes an optional `to` and calls `undo`; `cs_proj_redo` calls `redo`. `cs_proj_rename` takes `title` and calls `renameProject` on the session's project. `renameProject(project, title)` trims the title, refuses an empty one with `invalid_params`, and after every earlier create, rename and remove of `folders.ts` stores the title as the Workspace title when no other project uses it, else the title with the smallest free ` N` suffix from 2. `cs_proj_wait` takes `records`, a list of record IDs: an empty list fails with "Name at least one record ID to wait for.", and an unknown ID fails with the `unknown_record` error of `wait(project, records)` before any wait. It calls `wait(project, records)`, then returns `{records: [{record, status, intent, summary, outputs}]}` in the order named: `summary` is the operation summary of a `done` record, else its error message, else its status, and `outputs` names each output by role as the operation tools do (`outputsOf`). Its text is one line `<status> <record> (<intent>): <summary>` per record, each followed by the `- <role>: <asset> (<mime>) <url>` lines of its outputs. Every other tool returns the project summary of the current state: `record` (only after a tool that writes records: the newest record of the call, by `listHistory({tool_call})`), `project_id title head records`, then `agentSummaries` in order, then `stale` and `recent` (the last twelve records with their summaries, output URLs and reports). A field name used twice throws `invalid_params`. `projectSummary(project, deps, id, state, {written, reports, session})` is exported to the project messages, which pass `reports: false`; `session` is the calling or receiving session, passed to `agentSummaries`. Presentation metadata holds `cs_seen` (`SEEN_META_KEY` of `shared.ts`), a `ProjectShown` (`types.ts`) `{project, records: {<record>: <status>}, at?}`: `cs_proj_create` and `cs_proj_stale_accept` store `{record, cs_seen}` and `cs_proj_rename cs_proj_state cs_proj_undo cs_proj_redo` store `{cs_seen}`, where `cs_seen` is the summary's `project_id`, its `head` as `at`, and each `recent` record in its status; `cs_proj_wait` returns `{project, records}`, renders only the records, and stores `{cs_seen: {project, records}}` with each record in its status and no `at`; `cs_proj_history_list` stores none. An operation tool's value carries `project` (not rendered), and its metadata adds `cs_seen` with the call's record in the returned status, each scheduled record as `pending`, and `at` = the last scheduled record, else the call's record (no `at` for an `outsideHistory` operation, whose record leaves the position unchanged); a read adds none.

**Agent context.** While the DSH `systemPrompt` service is mounted, the service registers the system-prompt section `cs:project` (order `promptSectionOrder`, Config, default 4900; `interpolate: false`) and removes it with the service. `projectContext(project)` returns Project's rules and depends only on `listReferenceKinds()`: a conversation without a project starts with `cs_proj_create`, and once the project state message or `cs_proj_create` names its project it never calls `cs_proj_create` again; changes its own tool results did not show arrive as project updates and `cs_proj_state` reads the whole project; every call and every edit is a step at once; `cs_proj_undo` with or without `to` and `cs_proj_redo` are moves that add no step; a new change after a move discards the later steps so the agent asks first; things are named by record ID, `<record>#<n>`, `<id>@<version>` as a version of the registered kinds (left out while no kind is registered), asset ID, and the ID that the summary gives any other item, with the user pointing through `cs:` mentions and ambiguous references asked about; stale records. The text is the same for every session and step while the kinds stay the same, and names no project state, selection or preference the user cannot see.

**Project sight.** The `csProjectSight` session projection of `project-updates.ts` (host only, `stateVersion` 1, a zod state schema) folds what the agent of a session saw with `foldSeen`, into `{from: null}` or `{from, project, base, at, records}`. A surface replacement whose `endSeq >= from` resets to `{from: null}`. A `user/message` whose source kind is `cs-project` and whose `shown` has `base` (the project state message) starts the state from it with `from` = its seq; records `[0, base)` in write order count as seen `done` unless `records` names them. Any other `shown` (a project update message, or a `tool/result` whose `cs_seen` parses) of the state's project merges its `records` into `records` and sets `at` when it has one; one of another project, or while `from` is null, changes nothing. Metadata without a valid `cs_seen` and every other event return the same state reference.

**Project messages.** While the DSH `sessionProjections` service is mounted, the service registers the projection and an `agent/pre-step` listener (`registerProjectUpdates`); the projection state is read through the handle that `sessionProjections.register` resolves to, and a registry that refuses the projection gives the agent no project message. The listener awaits `next()` and returns the decision unchanged when it rejects, when the signal is aborted, or when it has no messages and either the step is the turn's first or the claimed messages were not empty (the loop runs no model call for such a step). Otherwise it inserts `projectMessage(project, deps, session, sight)` right after the last claimed message. `projectMessage` returns null for a session without a project; the project state message when `from` is null or the state is of another project; else the project update message, or null when it would be empty. The state message's text is "Project state. This conversation belongs to the project "<title>" in the folder <path>: do all work in it and never call cs_proj_create. Later changes that your own tool results did not show reach you as project updates. The project summary, as cs_proj_state returns it without the reports of recent records:" and the summary as indented JSON; its source is `{kind: 'cs-project', shown: {project, base: <listRecords length>, at, records: <every unfinished record → status>}, form: 'snapshot', sections: [{name: 'cs-project', text}]}`. With `seen(r)` = `records[r]`, else `done` for a record before `base`: the update lists, in write order, each record of the `parents[0]` ancestry of `at`, and each record of an `outsideHistory` operation, whose `seen` is absent, or unfinished while the record has finished; `moved` holds when `at` differs from the state's `at` and either `seen(at)` exists or the state's `at` is off that ancestry. The text is "Project updates since your last step:", then, when moved, `- history: the current step is <at>; cs_proj_history_list shows which steps are undone or discarded.`, then `- <status> <record> (<who>): <text>` per listed record (who: the user's surface as `user in chat`, `user in the app`, `user in history`, `user via API`; `your call` for an agent record of this session; `another chat`; `scheduled` for a system record; text: `summarize` with indented `outputLine`s for a done record, `<intent>: <error message>` for a failed or cancelled one, the intent for an unfinished one). Its source is `{kind: 'cs-project', shown: {project, at, records: <listed → status>}, form: 'notice', summary: "<n> project changes: <ids>"}` (bounded by `boundContextSummary`).

## 11. Test plan

Each test file builds modules with `startModules()` and projects with `createTestProject()` from `src/testing/support.ts`. Test names below are the `it(...)` titles; each line says what the test asserts. Required tests are marked (R).

**`src/record-store.test.ts` (A)**

- `writes a record line and an update line` (R): `append` then `update(running)` then `update(done, outputs, cost)`: `readLines` gives one record line with exactly the record-line fields and two `{"update": id}` lines; `getRecord` returns the current form with `started_at`, `finished_at`, `outputs`, `cost`; `getProject(id).path` is the project folder, and the folder holds only `.comfy-studio/` with `line.json` and `records.jsonl`.
- `refuses an append whose parent is not the current position`: `parent_not_head`, nothing written, no event.
- `refuses a backward or repeated status`: `done` → `running` and `running` → `running` throw `status_backwards`.
- `refuses an update of a finished record`: `record_finished` after `done`, `failed`, `cancelled`.
- `reloads records, updates and the line from disk`: a second `RecordStore` over the same project folders returns equal records and the same `{tip, at}` after a `moveTo`.
- `writes started_by on the record line only when the line has it, and reloads it`: the key follows `supersedes` on the line with its `lane`, a line without it has no key, and a reload returns it.
- `moves the current position without writing a record, and appends after it`: `moveTo` leaves `records.jsonl` unchanged and emits `line`; an append after the old `tip` throws `parent_not_head`; an append after `at` becomes `tip` and `at`; an unknown record throws `unknown_record`; a project without records has no line.
- `lists the record IDs of the history list with the index of the current position`: `lineIds` gives the list and the index of `at`; a write after a move leaves the later IDs out; a project without records gives `{ids: [], atIndex: -1}` and `requireLine` throws `invalid_params`.
- `fills resolved_asset of an output input once the producer is done`: record B with `{record: A, output: 0}`; null before A is done, A's output after; the file still has `null`.
- `returns copies that callers cannot use to change the store`.
- `serializes work under the project lock`: two `lock` calls with awaited delays run one after the other; another project's lock runs concurrently.
- `reads a project on first use, refuses to start an existing project, and forgets a removed project`: an unknown project throws `unknown_project`; `createProject` on a folder with `records.jsonl` throws `invalid_params`; after `forget` of a removed project, reads throw `unknown_project` and `records.jsonl` stays.
- `emits record, line and update events after the write`: events arrive in order with current forms, each after its change is on disk.

**`src/subscriptions.test.ts` (A)**

- `delivers events in subscription order and stops after removal`.
- `delivers the current event to the listeners subscribed when delivery started`.
- `keeps delivering when a listener throws`: the second listener still runs; `onListenerError` receives the error.

**`src/reducers.test.ts` (D)**

- `computes each registered slice from the records of the effective chain`: a test reducer counting records of its component; its slice and the `records` of the `proj` slice match the chain.
- `refuses a second reducer for a key`: `reducer_exists`.
- `marks consumers of a superseded record stale`: A outputs X, B consumes X, C supersedes A → `stale[B] = C`, `superseded[A] = C`, `created_by[X] = A`.
- `marks the consumer of a record's output stale when that record is superseded, though a later record output the same asset`: A outputs X, B consumes `A#0`, C outputs X again, D supersedes A → `created_by[X] = C`, `stale[B] = D`; a consumer that names the asset X is not stale.
- `keeps a record fresh after proj.stale_accept`: after the accept record, `stale[B]` is gone and stays gone after a later unrelated record.
- `registers one owner per reference kind and lists the kinds in registration order`: `kind_exists`; a remover removes only its own registration.
- `resolves version references through their reference kind, on the slice of its owner`: a test kind on the `test_bible` slice; null without the owner's reducer, for an unregistered kind and for an asset.
- `lists the kinds that have an ID and the newest version of an ID, on the slice of each owner`: two test kinds on the `test_bible` slice; none without the owner's reducer; registration order; null for an unknown ID and an unregistered kind.
- `marks records that read a superseded character version stale`: a test kind with `createdBy`; an update that supersedes the creating record marks the generation that read version 1 and the item made from it.

**`src/history.test.ts` (D)**

- `moves the current position on undo and redo without writing a record, and the state follows it` (R): `undo` moves `at` back one step and the state follows; `nothing_to_undo` at `proj.create`; `redo` moves forward again; `nothing_to_redo` at `tip`; `records.jsonl` is unchanged; each move emits `line`.
- `moves to a step before or after the current position, and a move to the current position changes nothing`: `moveTo` back and forward sets the state and the places; a move to `at` emits nothing; an unknown ID throws `unknown_record`.
- `discards the steps after the current position on a write: they leave the list and stay on disk` (R): `discardedSteps` names the later steps; a write after a move has `at` as its parent and becomes `tip` and `at`; the list and the state leave out the discarded steps; `redo` throws `nothing_to_redo` and `moveTo` a discarded step throws `invalid_params`; `listRecords` still has them.
- `cancels a discarded running step and a discarded queued step, and leaves the new step running` (R): a move alone cancels nothing; the write after it ends the running generation and the queued generation `cancelled` / `discarded`, and the queued render never executes.
- `lists the steps of the list newest first with their place, and filters them` (R): entries carry `after`, `current` and `before`; `actor`, `session`, `tool_call`, `records`, `before` and `limit` each narrow the list as specified; an unknown `before` throws `unknown_record`.

**`src/runner.test.ts` (B)**

- `runs an operation and records its outputs`: `done` record with outputs, `cost.reused: false`, measured `wall_seconds`, report.
- `copies started_by from the request onto the record of a run or a scheduled run`: an immediate run (with a `lane`) and a scheduled run (without one) carry the request's `started_by`; a run without it has none.
- `refuses invalid params, unknown inputs and unfinished inputs before writing`: `invalid_params`, `unknown_asset`, `input_not_ready`; the file is unchanged.
- `refuses a call that the operation's precondition refuses, before writing`.
- `adds the records an operation replaces to the record's supersedes`: `spec.supersedes` receives the params and the current state; its records follow `request.supersedes` without repeats.
- `fails the record when execute throws`: `failed` / `operation_failed` with the message; `run` resolves.
- `fails the record with the code of a thrown OperationFailure`: `failed` with that code and the message; and `OperationFailure` refuses a malformed code and the runner's own codes.
- `reuses outputs of an identical deterministic call`: second call `done` with `cost.reused: true`, execute not called.
- `reuses a deterministic call only when each role gets the same assets in the same order`: the same inputs with the roles named in another order are reused; the same assets in other roles, or in another order within a role, execute again.
- `writes no record for a read-only operation`: the file is unchanged; `report` is returned.
- `records a setting outside the history without a step, and folds it whatever the current position`: after an undo, an `outsideHistory` call keeps `{tip, at}`, emits no `line` event and leaves the history list unchanged; its component's slice holds the choice, also after a redo; a setting of a component without a reducer changes no slice.
- `refuses an operation whose name does not start with its component key`.
- `lets other edits run while a generation executes` (lock scope): an execute blocked on a promise; a second run on the same project finishes first.
- `loads a stored log whose operations and reference kind have no owner, and refuses a new call with that version`: a log with `image.generate_ref2va`, `deliver.batch_export` and an input `{character: 'c1', version: 1}` loads with only `proj` reduced and no stale mark; a new call with that input throws `invalid_inputs` and writes no record.
- `ends unfinished records at start`: a `pending` record from an earlier store → `cancelled` / `stopped` after `recover`.

**`src/scheduler.test.ts` (B)**

- `runs scheduled records in dependency order` (R, scheduler ordering): B `after` A and C with an input `{record: B, output: 0}`; execution order is A, B, C; C's input resolves to B's output.
- `keeps at most one gpu record running`: two independent `gpu` records with `limits.gpu = 1` never overlap; a `none` record runs meanwhile.
- `fails a record whose input record failed`: A fails → B `failed` / `input_failed` and never executes.
- `does not wait for the producers of pending input roles`: B with `pendingInputRoles: ['reference']` and a `reference` input `{record: A, output: 0}` runs while A is pending; run without `after` executes at once with `resolved_asset: null`, a scheduled B starts before A finishes, and A's failure leaves B `done`.
- `waits for every scheduled record of a project`: `wait(project)` resolves after the last record finishes.

**`src/agent-tools.test.ts`**

- Tool names, registration with the registry and removal with the operation.
- A call runs as the agent on the session's project and turn, carries `based_on` and `supersedes`, and returns outputs with URLs and image blocks; a failed record is a tool error. With an `agents` registry whose `turnBoundaryOf(session)` reports `lastTurn: 3`, the record's `turn` is `"3"` and its `session` and `tool_call` are the call's.
- `records no turn for a call outside any turn`: with `lastTurn: 0`, the record's `turn` is null.
- A read answers with its report and writes nothing; without an attachment service a result has no images.
- `formats a result as text plus image blocks, with its params unless the operation omits them`: the exact text block with the `params:` line, and without it for `omitParamsFromResult: true`.
- `prepareToolCall` changes the inputs, tool-only arguments stay out of params, an undeclared argument such as `project_id` is refused, and a call behind an unfinished producer is scheduled.
- `gives the agent the cs:project prompt section: Project's rules, the same text for an unbound and a bound conversation` (R): with a `systemPrompt` service mounted, the section holds the rules (the exact binding rule, the step, undo, redo and discard rules) and is the same text before the session is bound, after, and after a record is written.
- `names the registered reference kinds in the naming rule of the cs:project prompt section`: without a kind the rule names no `<id>@<version>`; with `test_location` and `test_style` it reads "a test_location or test_style version as <id>@<version>", and after the removal of `test_location` only "a test_style version".
- Held work delays a session's calls until it settles, even when it fails.
- Reference kinds need a registered component, refuse a second owner and the kinds `asset`, `record` and `version`, and appear in the `inputs` text of every tool, which follows each registration and removal.

**`src/proj-tools.test.ts`**

- Every `cs_proj_*` tool is registered while the registry is mounted and removed with the service.
- No tool opens another project and no tool argument names a project; create makes the chat's folder a project; a bound session refuses another project; every other tool fails in a conversation without a project.
- Each reducer's `agentSummary` fields sit between `records` and `stale`; a field used twice refuses the summary.
- `recent` lists summaries, failure messages, output URLs and pending statuses; history lists the steps with their operation and `place`.
- Undo (one step, and to a step before or after the current one) and redo move the current position and write no record; a write after a move discards the later steps, and undo to a discarded step fails; stale accept behaves as its method does.
- Undo and redo are read tools: their result names no record.
- Rename changes only the session's project: the title is trimmed, an empty title fails, a title another project uses gets ` 2`, and a call without a project fails.
- The record a write tool wrote leads its summary and its presentation metadata; every summary tool stores `cs_seen` with the summary's project, head and recent records, and `cs_proj_history_list` stores none.
- `cs_proj_wait reads the named records after they finish`: a record done before the call, a held record and a failing one, named in an order other than the one they finished in, give the exact text block and value after the held record finishes; an empty list and an unknown ID are refused; the metadata names each record in the status it showed.
- `parseInputs` for every reference form and every refusal.
- A session's project follows its folder across a restart, and a session that is not live, runs in a folder that is no Workspace, or runs in a Workspace without records has none; a run without an asset store fails.

**`src/project-updates.test.ts`**

- The project state message: the exact binding sentence, the summary without reports, and the logged source with `base`, `at` and the unfinished records; nothing for an unbound session; a state message when the session saw another project, and after the agent binds an unbound session with `cs_proj_create`.
- The project update message, with exact texts: nothing when nothing changed; a user import in the app with its output line; nothing for the agent's own operation call, its `cs_proj_undo`, or a finish its `cs_proj_wait` returned; the finish of a scheduled record seen pending, and a failure with intent and error, once; a user generation once running and once finished; an undo and a redo as move lines, and an undo plus a write as a move line with the new record; the user's undo of the agent's own record; nothing for a record written and undone before the agent saw it; `another chat` and `your call`; an undo followed by a redo nets out; a user's `outsideHistory` record after an undo is listed, and the agent's own one adds no move line.
- The `csProjectSight` fold: other tools' metadata, metadata of another project, and other events keep the same state reference; a surface replacement resets the state only when it reaches `from`, and the next step sends the state message; folding the log again after a restart gives the same state, which passes the state schema, and the same next message.

**`src/project-updates-listener.test.ts`**

- The `agent/pre-step` listener, dispatched as the agent loop dispatches it (a waterfall with the agent as `this`), beside a stand-in session projection registry: a step of a session bound to a project gets the project state message right after its own messages, and the session's state is read through the handle that `register` resolved to; a step of a session without a project is left alone; a registry that refuses the projection leaves every step alone and nothing is read.
