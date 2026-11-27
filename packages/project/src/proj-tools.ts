/**
 * Project's own agent tools, `cs_proj_*`: create and rename the conversation's project, read state and history, undo and
 * redo, accept a stale record, and wait for named records. `cs_proj_wait` returns each record it waited for, and every tool
 * except it and `cs_proj_history_list` returns the project summary of the current state: Project's fields (title, head,
 * record count, stale records, recent records) and the fields each component's reducer adds
 * through `Reducer.agentSummary`. A tool that writes records leads its summary with `record`, the newest record the call wrote, and
 * names that record in its presentation metadata (`{record}`), as the operation tools do. Every tool except
 * `cs_proj_history_list` also stores what its result showed of the project as `cs_seen` (a `ProjectShown`) in its
 * presentation metadata, which the model never reads: a summary tool names the summary's project, its head as the
 * position and its recent records, and `cs_proj_wait` names the records it waited for.
 * `cs_proj_create` makes the chat session's folder its project; every other tool works on that project only.
 *
 * Calls the `csProject` service's public methods and, through {@link ProjToolDeps}, the asset store, the reducers'
 * summaries and the turn of a call. Called by the service, which registers the tools while the DSH `tools` registry is mounted.
 *
 * @module @cs/project/proj-tools
 */
import { brandString } from "@deepseek-ai/dsh-brand";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool, type ToolDefinition, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  OUTPUT_SCHEMA,
  callProject,
  outputLine,
  outputsOf,
  sessionOf,
  toJson,
  type ToolOutput,
} from "./agent-tools.ts";
import type CsProject from "./index.ts";
import type { OperationSpec } from "./operation-types.ts";
import { ProjectError, SEEN_META_KEY } from "./shared.ts";
import type {
  AssetStore,
  ProjectId,
  ProjectRecord,
  ProjectShown,
  ProjectState,
  RecordId,
  RecordOrigin,
  RecordStatus,
  SessionId,
  TurnId,
} from "./types.ts";

/** What the `cs_proj_*` tools read besides the service's public methods. */
export interface ProjToolDeps {
  /** The registered asset store; throws when none is registered. */
  assets(): AssetStore;
  /**
   * The `agentSummary` fields of every reducer that defines it: Project's `proj` slice first, then the other components
   * in the alphabetical order of their keys, for the agent of `session`.
   */
  agentSummaries(state: ProjectState, session: SessionId): Array<Record<string, JsonValue>>;
  /** The agent turn a tool call belongs to, or null outside any turn. */
  turnOf(exec: Pick<ToolRunContext, "agent">): TurnId | null;
  /** The working directory of a chat session, or null for a session that is not live or records none. */
  chatFolder(session: SessionId): string | null;
}

/** The recent records a project summary lists. */
const RECENT_RECORDS = 12;

/** The history entries `cs_proj_history_list` returns when the call names no limit. */
const HISTORY_LIMIT = 20;

/** A project summary the agent can read. */
const STATE_SCHEMA = { type: "json" } as const;

/** The value of `cs_proj_wait`: the project, and each named record after it finished, in the order named. */
const WAIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    project: { type: "string", required: true },
    records: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          record: { type: "string", required: true },
          status: { type: "string", required: true },
          intent: { type: "string", required: true },
          summary: {
            type: "string",
            required: true,
            description: "The operation summary of a done record, else its error.",
          },
          outputs: { type: "array", required: true, items: OUTPUT_SCHEMA },
        },
      },
    },
  },
} as const;

/** One record in the value of `cs_proj_wait`. */
type WaitedRecord = {
  record: string;
  status: string;
  intent: string;
  summary: string;
  outputs: ToolOutput[];
};

/** The value of `cs_proj_wait`; the model reads only the records. */
type WaitValue = { project: string; records: WaitedRecord[] };

/**
 * The refusal a conversation that has a project gets when it tries to start another one: a conversation's folder never
 * changes.
 * @param title - the title of the conversation's project.
 * @returns the error text.
 */
function alreadyProjectMessage(title: string): string {
  return `This conversation's folder is already the project "${title}"; keep all work in it. Start a new conversation for a new project.`;
}

/**
 * Who makes a `cs_proj_*` tool's records: the agent, in the chat, in the call's session and turn.
 * @param deps - the turn of a call.
 * @param exec - the call.
 * @param intent - why.
 * @returns the origin.
 */
function originOf(
  deps: ProjToolDeps,
  exec: Pick<ToolRunContext, "agent" | "callId">,
  intent: string,
): RecordOrigin {
  return {
    actor: "agent",
    surface: "chat",
    session: sessionOf(exec),
    turn: deps.turnOf(exec),
    tool_call: exec.callId,
    intent,
  };
}

/**
 * The project summary of a state: the record a write wrote, Project's fields, then each component's `agentSummary`
 * fields, then the stale and recent records.
 * @param project - the service.
 * @param deps - the asset store and the reducers' summaries.
 * @param projectId - the project.
 * @param state - the project state.
 * @param options - `written`: the record the tool call wrote, or null for a read; `reports`: whether each recent record
 *   carries its `report` (the tools' summaries do, the project state message does not); `session`: the session whose
 *   agent reads the summary.
 * @returns the summary. Throws `invalid_params` when two summaries use the same field name.
 */
export function projectSummary(
  project: CsProject,
  deps: ProjToolDeps,
  projectId: ProjectId,
  state: ProjectState,
  options: { written: RecordId | null; reports: boolean; session: SessionId },
): JsonValue {
  const { written, reports, session } = options;
  const { proj } = state.components;
  const assets = deps.assets();
  const summary: Record<string, unknown> = {
    ...(written === null ? {} : { record: written }),
    project_id: projectId,
    title: project.openProject(projectId).title,
    head: state.head,
    records: proj.records.length,
  };
  const stale = Object.keys(proj.stale);
  const recent = proj.records.slice(-RECENT_RECORDS).map((record) => ({
    record: record.id,
    operation: record.operation,
    status: record.status,
    intent: record.intent,
    summary: recordSummary(project, record),
    outputs: record.outputs.map((id) => assets.url(id)),
    ...(reports ? { report: record.report } : {}),
    based_on: record.based_on,
    supersedes: record.supersedes,
  }));
  // Component fields sit between the record count and the stale records; no field may name two things.
  for (const fields of [...deps.agentSummaries(state, session), { stale, recent }]) {
    for (const [name, value] of Object.entries(fields)) {
      if (Object.hasOwn(summary, name))
        throw new ProjectError("invalid_params", `Two project summaries use the field ${name}.`);
      summary[name] = value;
    }
  }
  return toJson(summary);
}

/** One line for a record: its operation's summary when done, else its error message, else its status. */
function recordSummary(project: CsProject, record: ProjectRecord): string {
  return record.status === "done"
    ? summaryOf(project, record)
    : (record.error?.message ?? record.status);
}

/**
 * One line for a finished record: its operation's summary, else the operation name.
 * @param project - the service.
 * @param record - the record.
 * @returns the line.
 */
export function summaryOf(project: CsProject, record: ProjectRecord): string {
  return specOf(project, record)?.summarize(record) ?? record.operation ?? record.kind;
}

/**
 * @param project - the service.
 * @param record - a record.
 * @returns the registered operation of the record, or undefined for a record of no registered operation.
 */
export function specOf(project: CsProject, record: ProjectRecord): OperationSpec | undefined {
  return project.listOperations().find((candidate) => candidate.name === record.operation);
}

/**
 * A record as `cs_proj_wait` returns it.
 * @param project - the service.
 * @param assets - the asset store.
 * @param record - the record.
 * @returns its ID, status, intent, summary or error, and outputs named by role.
 */
function waitedRecord(project: CsProject, assets: AssetStore, record: ProjectRecord): WaitedRecord {
  return {
    record: record.id,
    status: record.status,
    intent: record.intent,
    summary: recordSummary(project, record),
    outputs: outputsOf(specOf(project, record)?.outputs ?? [], record, assets),
  };
}

/**
 * The text of a `cs_proj_wait` result: per record the line `<status> <record> (<intent>): <summary>`, then one line per
 * output.
 * @param value - the result.
 * @returns the text.
 */
function waitText(value: WaitValue): string {
  return value.records
    .flatMap((entry) => [
      `${entry.status} ${entry.record} (${entry.intent}): ${entry.summary}`,
      ...entry.outputs.map(outputLine),
    ])
    .join("\n");
}

/**
 * The presentation metadata of a write tool's summary: the record the call wrote.
 * @param value - the summary.
 * @returns `{record}`, with `record: ''` when the summary names no record.
 */
function writtenMeta(value: JsonValue): { record: string } {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value["record"]
      : undefined;
  return { record: typeof record === "string" ? record : "" };
}

/**
 * What a project summary showed, for its `cs_seen` metadata.
 * @param value - a summary of {@link projectSummary}.
 * @returns `{cs_seen}`: the summary's project, its head as the position, and each recent record in its status.
 */
function seenMeta(value: JsonValue): { [SEEN_META_KEY]: JsonValue } {
  // The value was built by `projectSummary`, which has exactly this shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const summary = value as {
    project_id: string;
    head: string;
    recent: Array<{ record: string; status: RecordStatus }>;
  };
  const shown: ProjectShown = {
    project: brandString<ProjectId>(summary.project_id),
    at: brandString<RecordId>(summary.head),
    records: Object.fromEntries(summary.recent.map((entry) => [entry.record, entry.status])),
  };
  return { [SEEN_META_KEY]: toJson(shown) };
}

/**
 * The `cs_proj_*` tools.
 * @param project - the service whose methods the tools call.
 * @param deps - the asset store and the reducers' summaries.
 * @returns the tool definitions.
 */
export function projTools(project: CsProject, deps: ProjToolDeps): ToolDefinition[] {
  const projectOf = (exec: ToolRunContext): ProjectId =>
    callProject(project.sessionProject(sessionOf(exec)));
  // The project's current state as the calling session's agent reads it, led by the record a write wrote.
  const summary = (
    exec: ToolRunContext,
    projectId: ProjectId,
    record: RecordId | null = null,
  ): JsonValue =>
    projectSummary(project, deps, projectId, project.getState(projectId), {
      written: record,
      reports: true,
      session: sessionOf(exec),
    });
  // The summary after a write, led by the newest record the call wrote.
  const written = (exec: ToolRunContext, projectId: ProjectId): JsonValue => {
    const [entry] = project.listHistory({ project: projectId, tool_call: exec.callId, limit: 1 });
    return summary(exec, projectId, entry?.record.id ?? null);
  };
  const historyOutput = {
    schema: STATE_SCHEMA,
    render: (_args: unknown, value: JsonValue): ContentBlock[] => [
      { type: "text", text: JSON.stringify(value, null, 1) },
    ],
  };
  const stateOutput = {
    ...historyOutput,
    presentationMeta: (_args: unknown, value: JsonValue): JsonValue => seenMeta(value),
  };
  const writeOutput = {
    ...historyOutput,
    presentationMeta: (_args: unknown, value: JsonValue): JsonValue => ({
      ...writtenMeta(value),
      ...seenMeta(value),
    }),
  };
  return [
    defineTool({
      name: "cs_proj_create",
      description:
        "Make this conversation's folder a project, only when the conversation has no project yet. " +
        "The project's files are kept in the folder's hidden .comfy-studio directory; the other files are left as " +
        "they are. Then do the work with the other cs_ tools.",
      parameters: { title: { type: "string", required: true } },
      output: writeOutput,
      execute: async (args, exec) => {
        const bound = project.sessionProject(sessionOf(exec));
        if (bound !== null)
          throw new Error(alreadyProjectMessage(project.openProject(bound).title));
        const folder = deps.chatFolder(sessionOf(exec));
        if (folder === null)
          throw new Error("This conversation has no folder to make a project in.");
        const info = await project.createProject(
          folder,
          args.title,
          originOf(deps, exec, `create project ${args.title}`),
        );
        return written(exec, info.id);
      },
    }),
    defineTool({
      name: "cs_proj_rename",
      description:
        "Rename this conversation's project and read its state. A title that another project uses gets the " +
        'suffix 2, 3, … (such as "Ad 2"); the summary\'s title is the stored one.',
      parameters: { title: { type: "string", required: true } },
      output: stateOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec);
        await project.renameProject(projectId, args.title);
        return summary(exec, projectId);
      },
    }),
    defineTool({
      name: "cs_proj_state",
      description:
        "Read the project: the items of each component with their IDs and versions, stale records, " +
        "and recent records.",
      parameters: {},
      output: stateOutput,
      execute: (_args, exec) => Promise.resolve(summary(exec, projectOf(exec))),
    }),
    defineTool({
      name: "cs_proj_history_list",
      description:
        "List the project history, newest first: each step with its operation, status, intent, and place: current " +
        "(the state the project shows), before, or after (a step that cs_proj_redo or cs_proj_undo with to brings back).",
      parameters: {
        limit: {
          type: "integer",
          description: `At most this many records; default ${HISTORY_LIMIT}.`,
        },
        operation: {
          type: "string",
          description: "Only records of this operation, such as proj.create.",
        },
      },
      output: historyOutput,
      execute: (args, exec) => {
        const projectId = projectOf(exec);
        const entries = project.listHistory({
          project: projectId,
          limit: args.limit ?? HISTORY_LIMIT,
          ...(args.operation === undefined ? {} : { operation: args.operation }),
        });
        return Promise.resolve(
          toJson(
            entries.map(({ record, place }) => ({
              record: record.id,
              place,
              operation: record.operation ?? record.kind,
              status: record.status,
              actor: record.actor,
              intent: record.intent,
              outputs: record.outputs,
            })),
          ),
        );
      },
    }),
    defineTool({
      name: "cs_proj_undo",
      description:
        "Move the project back to an earlier state. Without to, go back one step. With to, go to that step of " +
        "cs_proj_history_list, before or after the current one: the project shows its state just after that step. A move adds " +
        "no step. The steps after the current one stay until a new change is made; a new change discards them for good. " +
        "When the user asks to roll back, return to an earlier version or undo several changes, use this tool; never rebuild " +
        "the old state with new edits.",
      parameters: {
        to: {
          type: "string",
          description: "A record ID from cs_proj_history_list to go to; omit to go back one step.",
        },
      },
      output: stateOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec);
        await (args.to === undefined
          ? project.undo(projectId)
          : project.moveTo(projectId, brandString<RecordId>(args.to)));
        return summary(exec, projectId);
      },
    }),
    defineTool({
      name: "cs_proj_redo",
      description: "Move the project one step forward again, after an undo. A move adds no step.",
      parameters: {},
      output: stateOutput,
      execute: async (_args, exec) => {
        const projectId = projectOf(exec);
        await project.redo(projectId);
        return summary(exec, projectId);
      },
    }),
    defineTool({
      name: "cs_proj_stale_accept",
      description:
        "Accept a stale record as it is: its stale mark and the marks it passed to records made from it go away. " +
        "Call it only when the user accepts an out-of-date result instead of running it again.",
      parameters: {
        record: { type: "string", required: true, description: "The stale record ID." },
      },
      output: writeOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec);
        await project.acceptStale(
          projectId,
          brandString<RecordId>(args.record),
          originOf(deps, exec, `accept ${args.record}`),
        );
        return written(exec, projectId);
      },
    }),
    defineTool({
      name: "cs_proj_wait",
      description:
        "Wait until the records you name have finished or failed, then read each one: its status, its summary or " +
        "error, and its outputs.",
      parameters: {
        records: {
          type: "array",
          required: true,
          items: { type: "string" },
          description:
            "The record IDs to wait for: the records a result listed under scheduled, or a record whose status was pending.",
        },
      },
      output: {
        schema: WAIT_SCHEMA,
        render: (_args: unknown, value: WaitValue): ContentBlock[] => [
          { type: "text", text: waitText(value) },
        ],
        presentationMeta: (_args: unknown, value: WaitValue): JsonValue => {
          const shown: ProjectShown = {
            project: brandString<ProjectId>(value.project),
            records: Object.fromEntries(
              // The status was copied from a record, so it is one of the record statuses.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              value.records.map((entry) => [entry.record, entry.status as RecordStatus]),
            ),
          };
          return { [SEEN_META_KEY]: toJson(shown) };
        },
      },
      execute: async (args, exec) => {
        const projectId = projectOf(exec);
        const records = args.records.map((id) => brandString<RecordId>(id));
        if (records.length === 0) throw new Error("Name at least one record ID to wait for.");
        await project.wait(projectId, records);
        const assets = deps.assets();
        return {
          project: projectId,
          records: records.map((id) =>
            waitedRecord(project, assets, project.getRecord(projectId, id)),
          ),
        };
      },
    }),
  ];
}
