/**
 * Project messages: how the agent of a chat session learns about its project without a per-step system prompt.
 *
 * The agent gets the project state once, as the project state message: at the first step that has a bound project and
 * no view of it, and again when compaction or tool-result trimming shadowed that message. Afterwards each step whose
 * project changed in a way the agent has not seen gets one project update message: each record of the history list up
 * to the current position that the agent never saw, each such record it saw unfinished that has finished since, and
 * one line when the current position moved. Records that the agent's own tool results showed are not repeated, and a
 * step with nothing new gets no message.
 *
 * What the agent saw is the `csProjectSight` session projection, folded from the session's own log: the
 * {@link ProjectShown} in the source of each project message and in the `cs_seen` metadata of each project tool
 * result. A restart, a resume and a replay recover the same state from the log. The `agent/pre-step` listener adds the
 * message after the step's claimed messages; the agent loop logs it as a `user/message`, appended after the cached
 * history, so each request extends the previous one.
 *
 * Calls the `csProject` service's public reads and the project summary of the `proj-tools` module. Called by the
 * service, which registers the listener and the projection while the DSH `sessionProjections` service is mounted.
 *
 * @module @cs/project/project-updates
 */
import type { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import { brandString } from "@deepseek-ai/dsh-brand";
import {
  boundContextSummary,
  createUserMessage,
  type ContextFormed,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import { isReplacementSurfaceEvent, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition, ProjectionHandle } from "@deepseek-ai/dsh-session-projection";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { z as zod } from "zod";
import { outputLine, outputsOf } from "./agent-tools.ts";
import type CsProject from "./index.ts";
import { projectSummary, specOf, summaryOf, type ProjToolDeps } from "./proj-tools.ts";
import { SEEN_META_KEY } from "./shared.ts";
import type {
  ProjectId,
  ProjectRecord,
  ProjectShown,
  RecordId,
  RecordStatus,
  SessionId,
  Surface,
} from "./types.ts";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    /** A project message: the project state message (`snapshot`) or a project update message (`notice`). */
    "cs-project": { kind: "cs-project"; shown: ProjectShown } & Extract<
      ContextFormed,
      { form: "snapshot" | "notice" }
    >;
  }
}

/**
 * What the agent of one session has seen of its project. `from` is null until a project state message is logged, and
 * again after a surface replacement (compaction, tool-result trimming) whose range reaches that message.
 */
export type SessionSeen =
  | { from: null }
  | {
      /** The session seq of the project state message. */
      from: number;
      project: ProjectId;
      /** Records `[0, base)` in write order count as seen in a final status unless `records` names them. */
      base: number;
      /** The current position the agent last saw. */
      at: RecordId;
      /** Each record the agent saw after or unfinished at the state message, in the status it saw last. */
      records: Partial<Record<RecordId, RecordStatus>>;
    };

/** The message source kind of the project state message and the project update message. */
export const PROJECT_MESSAGE_KIND = "cs-project";

/** The first line of every project state message. */
export const STATE_HEAD = "Project state.";

/** The first line of every project update message. */
export const UPDATE_HEAD = "Project updates since your last step:";

/** The projection key. */
const SEEN_PROJECTION = "csProjectSight" as const;

/** Who a user record line names, by surface. */
const USER_SURFACE: Record<Surface, string> = {
  chat: "user in chat",
  view: "user in the app",
  api: "user via API",
  history: "user in history",
};

const recordId = zod.string().transform((value) => brandString<RecordId>(value));
const projectId = zod.string().transform((value) => brandString<ProjectId>(value));
const shownRecords = zod.record(
  zod.string(),
  zod.enum(["pending", "running", "done", "failed", "cancelled"]),
);
const shownSchema = zod.object({
  project: projectId,
  records: shownRecords,
  at: recordId.optional(),
});
const seenSchema = zod.union([
  zod.object({ from: zod.null() }),
  zod.object({
    from: zod.number().int().nonnegative(),
    project: projectId,
    base: zod.number().int().nonnegative(),
    at: recordId,
    records: shownRecords,
  }),
]);

/** The state of a session whose log holds no project state message. */
const UNSEEN: SessionSeen = { from: null };

/** Whether a record status is final. */
function finished(status: RecordStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** The record IDs of the `parents[0]` ancestry of `last`, which is the history list up to it. */
function ancestry(byId: ReadonlyMap<RecordId, ProjectRecord>, last: RecordId): Set<RecordId> {
  const chain = new Set<RecordId>();
  for (
    let id: RecordId | undefined = last;
    id !== undefined && byId.has(id) && !chain.has(id);
    id = byId.get(id)?.parents[0]
  ) {
    chain.add(id);
  }
  return chain;
}

/** What one session event showed the agent: a project message's source, or a tool result's `cs_seen`; else null. */
function shownBy(event: SessionEvent): ProjectShown | null {
  if (event.type === "user/message")
    return event.data.source.kind === PROJECT_MESSAGE_KIND ? event.data.source.shown : null;
  if (event.type !== "tool/result") return null;
  const meta = event.data.meta;
  if (typeof meta !== "object" || meta === null || !(SEEN_META_KEY in meta)) return null;
  const parsed = shownSchema.safeParse(meta[SEEN_META_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * The next state after one session event.
 * - A surface replacement whose range ends at or after `from` resets the state.
 * - A project state message starts the state from its source.
 * - A project update message or a tool result of the state's project adds its records, in the status shown, and moves
 *   `at` to the position it showed, if any.
 * Every other event returns the same state reference.
 * @param state - the state before the event.
 * @param event - the event.
 * @returns the state after it.
 */
export function foldSeen(state: SessionSeen, event: SessionEvent): SessionSeen {
  if (isReplacementSurfaceEvent(event))
    return state.from !== null && event.surfaceOp.endSeq >= state.from ? UNSEEN : state;
  const shown = shownBy(event);
  if (shown === null) return state;
  if (shown.base !== undefined)
    return {
      from: event.seq,
      project: shown.project,
      base: shown.base,
      at: shown.at,
      records: shown.records,
    };
  if (state.from === null || state.project !== shown.project) return state;
  return { ...state, at: shown.at ?? state.at, records: { ...state.records, ...shown.records } };
}

/**
 * The `csProjectSight` projection definition: the pure fold {@link foldSeen}.
 * @returns the definition.
 */
export function seenProjection(): ProjectionDefinition<typeof SEEN_PROJECTION, SessionSeen> {
  return {
    key: SEEN_PROJECTION,
    stateVersion: 1,
    stateSchema: seenSchema,
    init: () => UNSEEN,
    apply: foldSeen,
  };
}

/** Who a record line names: the user's surface (`user in another chat` for another chat), `your call`, `another chat`, or `scheduled`. */
function whoOf(record: ProjectRecord, session: SessionId): string {
  switch (record.actor) {
    case "user":
      return record.surface === "chat" && record.session !== null && record.session !== session
        ? "user in another chat"
        : USER_SURFACE[record.surface];
    case "agent":
      return record.session === session ? "your call" : "another chat";
    case "system":
      return "scheduled";
    default:
      return assertNever(record.actor);
  }
}

/** The lines of one record: `- <status> <record> (<who>): <text>`, then a done record's outputs, indented. */
function recordLines(
  project: CsProject,
  deps: ProjToolDeps,
  record: ProjectRecord,
  session: SessionId,
): string[] {
  const head = `- ${record.status} ${record.id} (${whoOf(record, session)}): `;
  switch (record.status) {
    case "done": {
      const outputs = outputsOf(specOf(project, record)?.outputs ?? [], record, deps.assets());
      return [
        `${head}${summaryOf(project, record)}`,
        ...outputs.map((output) => `  ${outputLine(output)}`),
      ];
    }
    case "failed":
    case "cancelled":
      return [`${head}${record.intent}: ${record.error?.message ?? record.status}`];
    case "pending":
    case "running":
      return [`${head}${record.intent}`];
    default:
      return assertNever(record.status);
  }
}

/**
 * The text of a project state message: the binding sentence, then the project summary of the current state without
 * the `report` of its recent records, as indented JSON (the format `cs_proj_state` returns).
 * @param project - the service.
 * @param deps - the asset store and the reducers' summaries.
 * @param id - the project.
 * @param session - the session whose agent reads the message.
 * @returns the text.
 */
export function renderState(
  project: CsProject,
  deps: ProjToolDeps,
  id: ProjectId,
  session: SessionId,
): string {
  const summary = projectSummary(project, deps, id, project.getState(id), {
    written: null,
    reports: false,
    session,
  });
  const info = project.openProject(id);
  return [
    `${STATE_HEAD} This conversation belongs to the project "${info.title}" in the folder ${info.path}: do all work in it ` +
      "and never call cs_proj_create. " +
      "Later changes that your own tool results did not show reach you as project updates. " +
      "The project summary, as cs_proj_state returns it without the reports of recent records:",
    JSON.stringify(summary, null, 1),
  ].join("\n");
}

/**
 * The project message one step of a session needs, or null.
 * - No bound project: null.
 * - No project state message in the state, or one of another project: the project state message, whose source shows
 *   every record written so far (`base`), the unfinished ones in their status, and the current position.
 * - Otherwise the project update message, or null when it would be empty. It lists, in write order, each record of the
 *   history list up to the current position, and each record outside the history (`OperationSpec.outsideHistory`), that
 *   the session never saw, or saw unfinished and is finished now. Before
 *   them, when the current position changed and the listed records do not explain it (the new position is a record the
 *   session saw, or the old one left the history list), it says
 *   `- history: the current step is <at>; cs_proj_history_list shows which steps are undone or discarded.`
 *   Its source shows the listed records in their status and the current position.
 * ```
 * Project updates since your last step:
 * - done r_5a10 (user in the app): imported knife.png
 *   - asset: 7be3… (image/png) https://…/cs/assets/7be3…
 * - failed r_7c22 (scheduled): generation 3 of batch b1 v2: The backend refused the request.
 * - running r_5b20 (user in the app): run generation 3 again
 * ```
 * A record line names the user's surface for a user record, `your call` for an agent record of this session,
 * `another chat` for an agent record of another session, and `scheduled` for a system record; its text is the
 * operation's summary for a done record, `<intent>: <error message>` for a failed or cancelled one, and the intent for
 * an unfinished one. A done record's outputs follow in the output line format of the operation tool results.
 * @param project - the service.
 * @param deps - the asset store and the reducers' summaries.
 * @param session - the agent's session ID.
 * @param seen - the session's `csProjectSight` state.
 * @returns the message, or null.
 */
export function projectMessage(
  project: CsProject,
  deps: ProjToolDeps,
  session: SessionId,
  seen: SessionSeen,
): UserMessage | null {
  const id = project.sessionProject(session);
  if (id === null) return null;
  const records = project.listRecords(id);
  const { at } = project.line(id);
  if (seen.from === null || seen.project !== id) {
    const text = renderState(project, deps, id, session);
    const open = Object.fromEntries(
      records
        .filter((record) => !finished(record.status))
        .map((record) => [record.id, record.status]),
    );
    return createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: PROJECT_MESSAGE_KIND,
        shown: { project: id, base: records.length, at, records: open },
        form: "snapshot",
        sections: [{ name: PROJECT_MESSAGE_KIND, text }],
      },
    });
  }
  const chain = ancestry(new Map(records.map((record) => [record.id, record])), at);
  const outside = new Set(
    project
      .listOperations()
      .filter((spec) => spec.outsideHistory === true)
      .map((spec) => spec.name),
  );
  const shown = new Map(
    records.map((record, index) => [
      record.id,
      seen.records[record.id] ?? (index < seen.base ? "done" : undefined),
    ]),
  );
  const listed = records.filter((record) => {
    const status = shown.get(record.id);
    const current = chain.has(record.id) || outside.has(String(record.operation));
    return current && (status === undefined || (!finished(status) && finished(record.status)));
  });
  const moved = at !== seen.at && (shown.get(at) !== undefined || !chain.has(seen.at));
  if (listed.length === 0 && !moved) return null;
  const lines = [
    UPDATE_HEAD,
    ...(moved
      ? [
          `- history: the current step is ${at}; cs_proj_history_list shows which steps are undone or discarded.`,
        ]
      : []),
    ...listed.flatMap((record) => recordLines(project, deps, record, session)),
  ];
  const ids = [...(moved ? [at] : []), ...listed.map((record) => record.id)];
  return createUserMessage({
    content: [{ type: "text", text: lines.join("\n") }],
    source: {
      kind: PROJECT_MESSAGE_KIND,
      form: "notice",
      summary: boundContextSummary(`${String(ids.length)} project changes: ${ids.join(", ")}`),
      shown: {
        project: id,
        at,
        records: Object.fromEntries(listed.map((record) => [record.id, record.status])),
      },
    },
  });
}

/**
 * Register the `csProjectSight` projection and the `agent/pre-step` listener under `ctx`. The listener awaits `next()`
 * and returns a reject decision, an aborted step, and an empty decision of a step that will not run (the first step of
 * a turn, or a step whose claimed messages a later listener removed) unchanged; otherwise it inserts
 * {@link projectMessage}'s message right after the last claimed message, so the user's own message precedes it.
 * @param ctx - a context with the `sessionProjections` service; disposal removes both.
 * @param project - the service.
 * @param deps - the asset store and the reducers' summaries.
 */
export function registerProjectUpdates(ctx: Context, project: CsProject, deps: ProjToolDeps): void {
  // Registration is asynchronous and yields the handle that reads the state. The listener is registered at once and
  // awaits the handle; a step of a registry that refused the projection gets no project message.
  const sight: Promise<ProjectionHandle<SessionSeen> | null> = ctx.sessionProjections
    .register(seenProjection())
    .catch((error: unknown) => {
      ctx
        .logger("csProject")
        .warn(
          "could not register the %s projection: %s",
          SEEN_PROJECTION,
          error instanceof Error ? error.message : String(error),
        );
      return null;
    });
  ctx.on(
    "agent/pre-step",
    async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
      const decision = await next();
      if (decision.kind === "reject" || signal.aborted) return decision;
      if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;
      const handle = await sight;
      if (handle === null || signal.aborted) return decision;
      const seen = handle.stateOf(agent.session);
      const message = projectMessage(project, deps, brandString<SessionId>(agent.id), seen);
      if (message === null) return decision;
      const last = decision.messages.findLastIndex((entry) => messages.includes(entry));
      return { ...decision, messages: decision.messages.toSpliced(last + 1, 0, message) };
    },
  );
}
