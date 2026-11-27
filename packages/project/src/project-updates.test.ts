/**
 * The project messages through the `csProject` service with the real DSH tool registry: the project state message, the
 * project update message for each kind of change, the records that the agent's own tool results showed, and the
 * `csProjectSight` fold over a session log built from the logged messages and tool results. Expected texts are written
 * from the rendering rules in `project-updates.ts`.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { brandString } from "@deepseek-ai/dsh-brand";
import {
  ToolCallId,
  createToolResultMessage,
  createUserMessage,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import { SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";
import CsProject, {
  type OperationSpec,
  type ProjectId,
  type ProjectRecord,
  type RecordId,
  type RecordOrigin,
  type SessionId,
} from "./index.ts";
import {
  STATE_HEAD,
  UPDATE_HEAD,
  foldSeen,
  projectMessage,
  seenProjection,
  type SessionSeen,
} from "./project-updates.ts";
import type { ProjToolDeps } from "./proj-tools.ts";
import { MemoryAssets, STAND_IN_COMPONENTS, tempRoot } from "./testing/support.ts";
import {
  chatProject,
  provideChatServices,
  type TestChatServices,
  callTool,
  mountTools,
} from "./testing/workspaces.ts";

/** The chat session of the agent under test. */
const SESSION = brandString<SessionId>("s1");

const contexts: Context[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

/** The asset ID of the bytes of a text. */
const assetOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A user edit on the canvas. */
const user = (intent: string): RecordOrigin => ({
  actor: "user",
  surface: "canvas",
  session: null,
  turn: null,
  tool_call: null,
  intent,
});
/** A record the scheduler runs. */
const scheduler = (intent: string): RecordOrigin => ({
  actor: "system",
  surface: "api",
  session: SESSION,
  turn: null,
  tool_call: null,
  intent,
});

/**
 * A session log of one agent: the events appended so far and the state folded from them, the way the agent loop logs
 * project messages and tool results.
 */
class AgentLog {
  readonly events: SessionEvent[] = [];
  seen: SessionSeen = seenProjection().init({} as never, 0 as never);

  private readonly project: CsProject;
  private readonly deps: ProjToolDeps;

  constructor(project: CsProject, deps: ProjToolDeps) {
    this.project = project;
    this.deps = deps;
  }

  /** Append an event and fold it. */
  append(event: SessionEvent): void {
    this.events.push(event);
    this.seen = foldSeen(this.seen, event);
  }

  /** The seq the next event gets. */
  get next(): SessionSeq {
    return SessionSeq(this.events.length);
  }

  /** Log a tool result with its persisted metadata. */
  toolResult(result: ToolExecutionResult): void {
    const message = createToolResultMessage({
      callId: ToolCallId(`call-${String(this.next)}`),
      content: result.content,
      isError: result.isError,
    });
    this.append({
      type: "tool/result",
      seq: this.next,
      time: 0,
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message,
        ...(result.meta === undefined ? {} : { meta: result.meta }),
      },
    });
  }

  /** Run the pre-step computation of one step and log its message; returns the message text, or null. */
  step(): string | null {
    const message = projectMessage(this.project, this.deps, SESSION, this.seen);
    if (message === null) return null;
    this.logMessage(message);
    return textOf(message);
  }

  /** Log a user message, as the agent loop logs a step's messages. */
  logMessage(message: UserMessage): void {
    this.append({
      type: "user/message",
      seq: this.next,
      time: 0,
      surfaceOp: "append",
      data: message,
    });
  }
}

/** The text of a message. */
function textOf(message: UserMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

interface Fixture {
  context: Context;
  project: CsProject;
  projectId: ProjectId;
  services: TestChatServices;
  deps: ProjToolDeps;
  log: AgentLog;
  /** Run one tool as the agent of {@link SESSION}. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
  /** Run one operation and return its record. */
  run(
    origin: RecordOrigin,
    operation: string,
    params: Record<string, unknown>,
    extra?: Partial<Parameters<CsProject["run"]>[0]>,
  ): Promise<ProjectRecord>;
  /** Let the render of `prompt` finish. */
  release(prompt: string): void;
}

/**
 * Mount the DSH tool registry and `csProject` with an in-memory asset store, two operations (`asset.import`, and a GPU
 * `shot.render` that waits until the test releases its prompt and fails for the prompt `broken`), and a project bound
 * to {@link SESSION} unless `bound` is false.
 * @param bound - whether {@link SESSION} starts bound to the project.
 * @returns the fixture.
 */
async function start(bound = true): Promise<Fixture> {
  const root = tempRoot();
  const context = new Context();
  contexts.push(context);
  const services = provideChatServices(context);
  await context.plugin(SystemPrompt, {}).await();
  await mountTools(context);
  await context
    .plugin(CsProject, {
      projectsFolder: join(root, "projects"),
      cpuConcurrency: 4,
      gpuConcurrency: 4,
      promptSectionOrder: 4900,
    })
    .await();
  const project = context.csProject;
  const assets = new MemoryAssets();
  project.registerAssetStore(assets);
  for (const key of STAND_IN_COMPONENTS) project.registerComponent(key);
  // One gate per prompt, made by whichever of the render and the release comes first.
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const gate = (prompt: string): { promise: Promise<void>; resolve: () => void } => {
    const existing = gates.get(prompt);
    if (existing !== undefined) return existing;
    let resolve = (): void => {};
    const made = {
      promise: new Promise<void>((done) => {
        resolve = done;
      }),
      resolve: () => {
        resolve();
      },
    };
    gates.set(prompt, made);
    return made;
  };
  const base = {
    version: "1",
    description: "A test operation.",
    inputs: {},
    deterministic: false,
  } as const;
  project.registerOperation({
    ...base,
    name: "asset.import",
    component: "asset",
    params: { name: { type: "string" } },
    outputs: [{ role: "asset", type: "image" }],
    resource: "none",
    summarize: (record) => `imported ${String(record.params["name"])}`,
    inputs: { reference: { type: "image", description: "An earlier image." } },
    execute: (call) =>
      Promise.resolve({
        outputs: [
          call.importAsset(Buffer.from(String(call.params["name"])), {
            mime: "image/png",
            name: "x.png",
          }),
        ],
      }),
  } satisfies OperationSpec);
  project.registerOperation({
    ...base,
    name: "shot.render",
    component: "shot",
    params: { prompt: { type: "string" } },
    outputs: [{ role: "video", type: "video" }],
    resource: "gpu",
    summarize: (record) => `shot ${String(record.params["prompt"])}`,
    execute: async (call) => {
      const prompt = String(call.params["prompt"]);
      await gate(prompt).promise;
      if (prompt === "broken") throw new Error("The backend refused the request.");
      return {
        outputs: [call.importAsset(Buffer.from(prompt), { mime: "video/mp4", name: "shot.mp4" })],
      };
    },
  } satisfies OperationSpec);
  // An unbound session runs in a folder of its own, which cs_proj_create can make a project.
  if (!bound) services.chats.open(SESSION, await project.newProjectFolder("From chat"));
  const projectId = bound
    ? await chatProject(project, services, "Knife ad", user("create"))
    : (
        await project.createProject(
          await project.newProjectFolder("Knife ad"),
          "Knife ad",
          user("create"),
        )
      ).id;
  const deps: ProjToolDeps = {
    assets: () => assets,
    agentSummaries: () => [],
    turnOf: () => null,
    chatFolder: () => null,
  };
  let calls = 0;
  return {
    context,
    project,
    projectId,
    services,
    deps,
    log: new AgentLog(project, deps),
    call(name, args) {
      calls += 1;
      const agent = { id: SESSION, session: { id: SESSION } };
      return callTool(context, `call-${calls}`, name, args, agent);
    },
    async run(origin, operation, params, extra = {}) {
      const result = await project.run({
        ...origin,
        project: projectId,
        operation,
        params,
        inputs: [],
        ...extra,
      });
      if (result.record === null) throw new Error("the operation wrote no record");
      return result.record;
    },
    release(prompt) {
      gate(prompt).resolve();
    },
  };
}

/** Wait until a record has the status. */
async function until(
  project: CsProject,
  projectId: ProjectId,
  record: RecordId,
  status: string,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 200 && project.getRecord(projectId, record).status !== status;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(project.getRecord(projectId, record).status).toBe(status);
}

/** The update text of the given body lines. */
const update = (...lines: string[]): string => [UPDATE_HEAD, ...lines].join("\n");

describe("project state message", () => {
  it("starts with the binding sentence and the project summary without reports, and logs what it showed", async () => {
    const fixture = await start();
    const record = await fixture.run(user("import knife"), "asset.import", { name: "knife.png" });
    const render = await fixture.run(
      user("render"),
      "shot.render",
      { prompt: "held" },
      { after: [] },
    );
    await until(fixture.project, fixture.projectId, render.id, "running");
    const message = projectMessage(fixture.project, fixture.deps, SESSION, fixture.log.seen);
    const text = message === null ? "" : textOf(message);
    const [head, ...json] = text.split("\n");
    const { title, path } = fixture.project.openProject(fixture.projectId);
    expect(head).toBe(
      `${STATE_HEAD} This conversation belongs to the project "${title}" in the folder ${path}: do all work in it ` +
        "and never call cs_proj_create. Later changes that your own tool results did not show reach you as DreamVerse project updates. " +
        "The project summary, as cs_proj_state returns it without the reports of recent records:",
    );
    const summary = JSON.parse(json.join("\n")) as {
      project_id: string;
      head: string;
      recent: Array<Record<string, unknown>>;
    };
    expect(summary).toMatchObject({ project_id: fixture.projectId, head: render.id });
    expect(summary.recent.at(-2)).toEqual({
      record: record.id,
      operation: "asset.import",
      status: "done",
      intent: "import knife",
      summary: "imported knife.png",
      outputs: [`https://assets.example/${assetOf("knife.png")}`],
      based_on: null,
      supersedes: [],
    });
    expect(message?.source).toEqual({
      kind: "cs-project",
      form: "snapshot",
      sections: [{ name: "cs-project", text }],
      shown: {
        project: fixture.projectId,
        base: 3,
        at: render.id,
        records: { [render.id]: "running" },
      },
    });
  });

  it("gives the component summaries the session that receives the state message", async () => {
    const fixture = await start();
    const deps: ProjToolDeps = {
      ...fixture.deps,
      agentSummaries: (_state, session) => [{ viewer: session }],
    };
    const message = projectMessage(fixture.project, deps, SESSION, fixture.log.seen);
    const [, ...json] = (message === null ? "" : textOf(message)).split("\n");
    expect(JSON.parse(json.join("\n"))).toMatchObject({ viewer: SESSION });
  });

  it("sends nothing for a session without a project, and a state message when the session saw another project", async () => {
    const fixture = await start();
    expect(
      projectMessage(
        fixture.project,
        fixture.deps,
        brandString<SessionId>("unbound"),
        fixture.log.seen,
      ),
    ).toBeNull();
    expect(fixture.log.step()).toMatch(/^DreamVerse project state\./);
    // What the agent of SESSION saw, read for a session whose folder is another project.
    await chatProject(fixture.project, fixture.services, "Other", user("create"), "s2");
    const message = projectMessage(
      fixture.project,
      fixture.deps,
      brandString<SessionId>("s2"),
      fixture.log.seen,
    );
    expect(message === null ? "" : textOf(message)).toContain(
      'This conversation belongs to the project "Other"',
    );
  });

  it("sends the state message after the agent binds an unbound conversation with cs_proj_create", async () => {
    const fixture = await start(false);
    expect(fixture.log.step()).toBeNull();
    fixture.log.toolResult(await fixture.call("cs_proj_create", { title: "From chat" }));
    expect(fixture.log.step()).toMatch(
      /^DreamVerse project state\. This conversation belongs to the project "From chat" /,
    );
    expect(fixture.log.step()).toBeNull();
  });
});

describe("project update message", () => {
  it("sends nothing when nothing changed since the last message", async () => {
    const fixture = await start();
    expect(fixture.log.step()).toMatch(/^DreamVerse project state\./);
    expect(fixture.log.step()).toBeNull();
  });

  it("reports a user import on the canvas with its output line, in the operation tool result output format", async () => {
    const fixture = await start();
    fixture.log.step();
    const record = await fixture.run(user("import knife"), "asset.import", { name: "knife.png" });
    const asset = assetOf("knife.png");
    expect(fixture.log.step()).toBe(
      update(
        `- done ${record.id} (user on canvas): imported knife.png`,
        `  - asset: ${asset} (image/png) https://assets.example/${asset}`,
      ),
    );
    expect(fixture.log.step()).toBeNull();
  });

  it("repeats nothing that the agent's own tool results showed: an operation call, cs_proj_undo, and a finish cs_proj_wait returned", async () => {
    const fixture = await start();
    fixture.log.step();
    fixture.log.toolResult(
      await fixture.call("cs_asset_import", { reason: "product", name: "product.png" }),
    );
    expect(fixture.log.step()).toBeNull();
    fixture.log.toolResult(await fixture.call("cs_proj_undo", {}));
    expect(fixture.log.step()).toBeNull();
    const render = await fixture.run(
      scheduler("shot 1"),
      "shot.render",
      { prompt: "one" },
      { after: [] },
    );
    fixture.log.toolResult({
      isError: false,
      value: {},
      content: [],
      meta: {
        cs_seen: { project: fixture.projectId, at: render.id, records: { [render.id]: "pending" } },
      },
    });
    await until(fixture.project, fixture.projectId, render.id, "running");
    fixture.release("one");
    fixture.log.toolResult(await fixture.call("cs_proj_wait", { records: [render.id] }));
    expect(fixture.log.step()).toBeNull();
  });

  it("reports the finish of a scheduled record the agent saw pending once, and a failure with its intent and error", async () => {
    const fixture = await start();
    fixture.log.step();
    const one = await fixture.run(
      scheduler("shot 1 of plan p1"),
      "shot.render",
      { prompt: "one" },
      { after: [] },
    );
    const broken = await fixture.run(
      scheduler("shot 2 of plan p1"),
      "shot.render",
      { prompt: "broken" },
      { after: [] },
    );
    // The approval result listed both renders under scheduled.
    fixture.log.toolResult({
      isError: false,
      value: {},
      content: [],
      meta: {
        cs_seen: {
          project: fixture.projectId,
          at: broken.id,
          records: { [one.id]: "pending", [broken.id]: "pending" },
        },
      },
    });
    expect(fixture.log.step()).toBeNull();
    await until(fixture.project, fixture.projectId, broken.id, "running");
    fixture.release("one");
    fixture.release("broken");
    await fixture.project.wait(fixture.projectId);
    const asset = assetOf("one");
    expect(fixture.log.step()).toBe(
      update(
        `- done ${one.id} (scheduled): shot one`,
        `  - video: ${asset} (video/mp4) https://assets.example/${asset}`,
        `- failed ${broken.id} (scheduled): shot 2 of plan p1: The backend refused the request.`,
      ),
    );
    expect(fixture.log.step()).toBeNull();
  });

  it("reports a user render once while it runs and once when it finishes", async () => {
    const fixture = await start();
    fixture.log.step();
    const render = await fixture.run(
      user("render shot 3 again"),
      "shot.render",
      { prompt: "three" },
      { after: [] },
    );
    await until(fixture.project, fixture.projectId, render.id, "running");
    expect(fixture.log.step()).toBe(
      update(`- running ${render.id} (user on canvas): render shot 3 again`),
    );
    expect(fixture.log.step()).toBeNull();
    fixture.release("three");
    await fixture.project.wait(fixture.projectId);
    expect(fixture.log.step()).toBe(
      update(
        `- done ${render.id} (user on canvas): shot three`,
        `  - video: ${assetOf("three")} (video/mp4) https://assets.example/${assetOf("three")}`,
      ),
    );
    expect(fixture.log.step()).toBeNull();
  });

  it("reports an undo and a redo as moves, and an undo followed by a write as a move with the new record", async () => {
    const fixture = await start();
    const first = await fixture.run(user("a"), "asset.import", { name: "a.png" });
    const second = await fixture.run(user("b"), "asset.import", { name: "b.png" });
    await fixture.run(user("c"), "asset.import", { name: "c.png" });
    fixture.log.step();
    await fixture.project.undo(fixture.projectId);
    await fixture.project.undo(fixture.projectId);
    expect(fixture.log.step()).toBe(
      update(
        `- history: the current step is ${first.id}; cs_proj_history_list shows which steps are undone or discarded.`,
      ),
    );
    await fixture.project.redo(fixture.projectId);
    expect(fixture.log.step()).toBe(
      update(
        `- history: the current step is ${second.id}; cs_proj_history_list shows which steps are undone or discarded.`,
      ),
    );
    await fixture.project.undo(fixture.projectId);
    const written = await fixture.run(user("d"), "asset.import", { name: "d.png" });
    expect(fixture.log.step()).toBe(
      update(
        `- history: the current step is ${written.id}; cs_proj_history_list shows which steps are undone or discarded.`,
        `- done ${written.id} (user on canvas): imported d.png`,
        `  - asset: ${assetOf("d.png")} (image/png) https://assets.example/${assetOf("d.png")}`,
      ),
    );
  });

  it("reports the user's undo of a record the agent's own call wrote, and skips a record written and undone before the agent saw it", async () => {
    const fixture = await start();
    fixture.log.step();
    const own = await fixture.call("cs_asset_import", { reason: "product", name: "product.png" });
    fixture.log.toolResult(own);
    await fixture.project.undo(fixture.projectId);
    const head = fixture.project.line(fixture.projectId).at;
    expect(fixture.log.step()).toBe(
      update(
        `- history: the current step is ${head}; cs_proj_history_list shows which steps are undone or discarded.`,
      ),
    );
    await fixture.project.moveTo(fixture.projectId, head);
    await fixture.run(user("passing"), "asset.import", { name: "passing.png" });
    await fixture.project.undo(fixture.projectId);
    expect(fixture.log.step()).toBeNull();
  });

  it("names a record of another chat session and an unreported record of this session's agent", async () => {
    const fixture = await start();
    fixture.log.step();
    const agent = (session: string): RecordOrigin => ({
      actor: "agent",
      surface: "chat",
      session: brandString<SessionId>(session),
      turn: null,
      tool_call: "call-x",
      intent: "agent import",
    });
    const other = await fixture.run(agent("s2"), "asset.import", { name: "other.png" });
    const stopped = await fixture.run(agent(SESSION), "asset.import", { name: "stopped.png" });
    expect(fixture.log.step()).toBe(
      update(
        `- done ${other.id} (another chat): imported other.png`,
        `  - asset: ${assetOf("other.png")} (image/png) https://assets.example/${assetOf("other.png")}`,
        `- done ${stopped.id} (your call): imported stopped.png`,
        `  - asset: ${assetOf("stopped.png")} (image/png) https://assets.example/${assetOf("stopped.png")}`,
      ),
    );
  });

  it("names a user edit made in another chat apart from one made in this chat", async () => {
    const fixture = await start();
    fixture.log.step();
    const human = (session: string): RecordOrigin => ({
      actor: "user",
      surface: "chat",
      session: brandString<SessionId>(session),
      turn: null,
      tool_call: null,
      intent: "user import",
    });
    const other = await fixture.run(human("s2"), "asset.import", { name: "other.png" });
    const here = await fixture.run(human(SESSION), "asset.import", { name: "here.png" });
    expect(fixture.log.step()).toBe(
      update(
        `- done ${other.id} (user in another chat): imported other.png`,
        `  - asset: ${assetOf("other.png")} (image/png) https://assets.example/${assetOf("other.png")}`,
        `- done ${here.id} (user in chat): imported here.png`,
        `  - asset: ${assetOf("here.png")} (image/png) https://assets.example/${assetOf("here.png")}`,
      ),
    );
  });

  it("reports a user setting outside the history after an undo, and no move for the agent's own setting", async () => {
    const fixture = await start();
    fixture.project.registerOperation({
      version: "1",
      description: "A setting outside the history.",
      inputs: {},
      deterministic: false,
      outputs: [],
      resource: "none",
      name: "shot.choose",
      component: "shot",
      params: { model: { type: "string" } },
      outsideHistory: true,
      summarize: (record) => `chose ${String(record.params["model"])}`,
      execute: () => Promise.resolve({ outputs: [] }),
    } satisfies OperationSpec);
    await fixture.run(user("a"), "asset.import", { name: "a.png" });
    fixture.log.step();
    await fixture.project.undo(fixture.projectId);
    const head = fixture.project.line(fixture.projectId).at;
    const chosen = await fixture.run(user("choose"), "shot.choose", { model: "pika" });
    expect(fixture.log.step()).toBe(
      update(
        `- history: the current step is ${head}; cs_proj_history_list shows which steps are undone or discarded.`,
        `- done ${chosen.id} (user on canvas): chose pika`,
      ),
    );
    fixture.log.toolResult(
      await fixture.call("cs_shot_choose", { reason: "own choice", model: "wan" }),
    );
    expect(fixture.log.step()).toBeNull();
  });

  it("nets out an undo followed by a redo", async () => {
    const fixture = await start();
    await fixture.run(user("a"), "asset.import", { name: "a.png" });
    fixture.log.step();
    await fixture.project.undo(fixture.projectId);
    await fixture.project.redo(fixture.projectId);
    expect(fixture.log.step()).toBeNull();
  });
});

describe("csProjectSight fold", () => {
  it("ignores the metadata of other tools and returns the same state for events it does not read", async () => {
    const fixture = await start();
    fixture.log.step();
    const before = fixture.log.seen;
    fixture.log.toolResult({
      isError: false,
      value: {},
      content: [],
      meta: { record: "r1", tool: "other" },
    });
    fixture.log.toolResult({
      isError: false,
      value: {},
      content: [],
      meta: { cs_seen: { kind: "unknown" } },
    });
    fixture.log.toolResult({
      isError: false,
      value: {},
      content: [],
      meta: { cs_seen: { project: "other", records: {} } },
    });
    fixture.log.append({ type: "turn/start", seq: fixture.log.next, time: 0, data: { turn: 2 } });
    expect(fixture.log.seen).toBe(before);
  });

  it("resets when a surface replacement reaches the project state message, and only then", async () => {
    const fixture = await start();
    fixture.log.append({ type: "turn/start", seq: fixture.log.next, time: 0, data: { turn: 1 } });
    fixture.log.step();
    const from = fixture.log.seen.from ?? -1;
    expect(from).toBe(1);
    const checkpoint = (endSeq: number): SessionEvent => ({
      type: "user/message",
      seq: fixture.log.next,
      time: 0,
      surfaceOp: { op: "replace", startSeq: SessionSeq(0), endSeq: SessionSeq(endSeq) },
      data: createUserMessage({
        content: [{ type: "text", text: "Summary of the earlier conversation." }],
        source: { kind: "user" },
      }),
    });
    const before = fixture.log.seen;
    fixture.log.append(checkpoint(0));
    expect(fixture.log.seen).toBe(before);
    fixture.log.append(checkpoint(from));
    expect(fixture.log.seen).toEqual({ from: null });
    expect(fixture.log.step()).toMatch(/^DreamVerse project state\./);
  });

  it("recovers the same state and the same next message when the log is folded again after a restart", async () => {
    const fixture = await start();
    fixture.log.step();
    fixture.log.toolResult(
      await fixture.call("cs_asset_import", { reason: "product", name: "product.png" }),
    );
    const render = await fixture.run(
      user("render"),
      "shot.render",
      { prompt: "four" },
      { after: [] },
    );
    await until(fixture.project, fixture.projectId, render.id, "running");
    fixture.log.step();
    const definition = seenProjection();
    const replayed = fixture.log.events.reduce(
      (state, event) => definition.apply(state, event),
      definition.init({} as never, 0 as never),
    );
    expect(replayed).toEqual(fixture.log.seen);
    expect(definition.stateSchema.parse(JSON.parse(JSON.stringify(replayed)))).toEqual(replayed);
    fixture.release("four");
    await fixture.project.wait(fixture.projectId);
    expect(projectMessage(fixture.project, fixture.deps, SESSION, replayed)).toEqual(
      expect.objectContaining({
        content: projectMessage(fixture.project, fixture.deps, SESSION, fixture.log.seen)?.content,
      }),
    );
  });
});
