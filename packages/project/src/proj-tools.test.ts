/**
 * Project's own `cs_proj_*` tools through the `csProject` service with the real DSH tool registry: making the chat's
 * folder a project, projects as Workspaces (create, re-add, remove), tools that work only on the conversation's project,
 * renaming the session's project, the project summary with the reducers' `agentSummary` fields, the history list, undo
 * and redo, moves to a step, stale acceptance, and waiting for named records.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { brandString } from "@deepseek-ai/dsh-brand";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import CsProject, {
  type AssetId,
  type OperationSpec,
  type OperationToolValue,
  type ProjectId,
  type SessionId,
} from "./index.ts";
import { MemoryAssets, STAND_IN_COMPONENTS, tempRoot } from "./testing/support.ts";
import {
  provideChatServices,
  type TestChatServices,
  TestWorkspace,
  callTool,
  mountTools,
} from "./testing/workspaces.ts";

declare module "@cs/project" {
  interface ComponentStates {
    /** The slice of the test reducer that adds a field to the project summary: the assets of finished records. */
    proj_tools_test?: { assets: AssetId[] };
  }
}

/** Every `cs_proj_*` tool. */
const PROJ_TOOLS = [
  "cs_proj_create",
  "cs_proj_rename",
  "cs_proj_state",
  "cs_proj_history_list",
  "cs_proj_undo",
  "cs_proj_redo",
  "cs_proj_stale_accept",
  "cs_proj_wait",
];

interface Fixture {
  context: Context;
  project: CsProject;
  assets: MemoryAssets;
  /** The `csProject` plugin's fiber. */
  fiber: { dispose(): Promise<unknown> };
  services: TestChatServices;
  /** The folder of chat session `s1`, which is no project at the start. */
  chatFolder: string;
  /** Run one tool as the agent of chat session `s1`, or of `session`. */
  call(name: string, args: Record<string, unknown>, session?: string): Promise<ToolExecutionResult>;
}

const contexts: Context[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

/**
 * Mount the DSH tool registry and `csProject` with an in-memory asset store.
 * @returns the fixture.
 */
async function start(): Promise<Fixture> {
  const root = tempRoot();
  const context = new Context();
  contexts.push(context);
  const services = provideChatServices(context);
  const chatFolder = join(root, "chat");
  mkdirSync(chatFolder);
  services.chats.open("s1", chatFolder);
  await context.plugin(SystemPrompt, {}).await();
  await mountTools(context);
  const fiber = context.plugin(CsProject, {
    projectsFolder: join(root, "projects"),
    cpuConcurrency: 4,
    gpuConcurrency: 1,
    promptSectionOrder: 4900,
  });
  await fiber.await();
  const assets = new MemoryAssets();
  context.csProject.registerAssetStore(assets);
  for (const key of STAND_IN_COMPONENTS) context.csProject.registerComponent(key);
  let calls = 0;
  return {
    context,
    project: context.csProject,
    assets,
    fiber,
    services,
    chatFolder,
    call(name, args, session = "s1") {
      calls += 1;
      return callTool(context, `call-${calls}`, name, args, { id: session });
    },
  };
}

/**
 * An operation that makes a still from its `prompt` param and an optional `reference` input.
 * @param overrides - the fields to change.
 * @returns the spec.
 */
function still(overrides: Partial<OperationSpec> = {}): OperationSpec {
  return {
    name: "asset.crop",
    component: "asset",
    version: "1",
    description: "A test operation.",
    params: { prompt: { type: "string" } },
    inputs: { reference: { type: "image", description: "A reference." } },
    outputs: [{ role: "still", type: "image" }],
    deterministic: false,
    resource: "none",
    summarize: (record) => `made from ${String(record.params["prompt"])}`,
    execute: (context) =>
      Promise.resolve({
        outputs: [
          context.importAsset(Buffer.from(`still ${String(context.params["prompt"])}`), {
            mime: "image/png",
            name: "still.png",
          }),
        ],
      }),
    ...overrides,
  };
}

/** The JSON value of a successful `cs_proj_*` call. */
function json(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) throw new Error(result.error.message);
  return result.value as Record<string, unknown>;
}

/** The value of a successful operation tool call. */
function value(result: ToolExecutionResult): OperationToolValue {
  if (result.isError) throw new Error(result.error.message);
  return result.value as OperationToolValue;
}

/** The error message of a failed call. */
function errorOf(result: ToolExecutionResult): string {
  return result.isError ? result.error.message : "";
}

describe("cs_proj_* tools", () => {
  it("registers every cs_proj_* tool while the registry is mounted and removes them with the service", async () => {
    const fixture = await start();
    for (const name of PROJ_TOOLS) expect(fixture.context.tools.get(name), name).toBeDefined();
    const state = fixture.context.tools
      .get("cs_proj_state")
      ?.output?.render?.({}, { project_id: "p" });
    expect(state).toEqual([{ type: "text", text: '{\n "project_id": "p"\n}' }]);
    await fixture.fiber.dispose();
    for (const name of PROJ_TOOLS) expect(fixture.context.tools.get(name), name).toBeUndefined();
  });

  it("has no tool that opens another project and no tool argument that names a project", async () => {
    const fixture = await start();
    fixture.project.registerOperation(still());
    expect(fixture.context.tools.get("cs_proj_open")).toBeUndefined();
    const schemas = fixture.context.tools.schemas().filter((tool) => tool.name.startsWith("cs_"));
    expect(schemas.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...PROJ_TOOLS, "cs_asset_crop"]),
    );
    for (const tool of schemas) {
      expect(
        Object.keys((tool.parameters as { properties: object }).properties),
        tool.name,
      ).not.toContain("project_id");
    }
  });

  it("creates this conversation's project, and keeps a bound conversation in its project", async () => {
    const fixture = await start();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["cs_proj_state", {}],
      ["cs_proj_history_list", {}],
      ["cs_proj_undo", {}],
      ["cs_proj_redo", {}],
      ["cs_proj_wait", { records: ["r"] }],
      ["cs_proj_stale_accept", { record: "r" }],
    ];
    for (const [name, args] of calls) {
      expect(errorOf(await fixture.call(name, args)), name).toBe(
        "This conversation has no project yet: call cs_proj_create first.",
      );
    }
    const created = json(await fixture.call("cs_proj_create", { title: "dance" }));
    const projectId = brandString<ProjectId>(String(created["project_id"]));
    expect(created).toEqual({
      record: created["head"],
      project_id: projectId,
      head: expect.any(String),
      records: 1,
      title: "dance",
      stale: [],
      recent: [
        expect.objectContaining({
          operation: "proj.create",
          status: "done",
          summary: "proj.create",
          intent: "create project dance",
        }),
      ],
    });
    expect(fixture.project.sessionProject(brandString<SessionId>("s1"))).toBe(projectId);
    expect(fixture.project.listHistory({ project: projectId })[0]?.record).toMatchObject({
      actor: "agent",
      surface: "chat",
      intent: "create project dance",
    });
    expect(errorOf(await fixture.call("cs_proj_create", { title: "other" }))).toBe(
      'This conversation\'s folder is already the project "dance"; keep all work in it. Start a new conversation for a new project.',
    );
    expect(errorOf(await fixture.call("cs_proj_create", { title: "nowhere" }, "s9"))).toBe(
      "This conversation has no folder to make a project in.",
    );
    const origin = {
      actor: "user" as const,
      surface: "api" as const,
      session: null,
      turn: null,
      tool_call: null,
      intent: "other",
    };
    await fixture.project.createProject(
      await fixture.project.newProjectFolder("other"),
      "other",
      origin,
    );
    expect(json(await fixture.call("cs_proj_state", {}))).toMatchObject({
      project_id: projectId,
      title: "dance",
    });
  });

  it("renames only this conversation's project, trimmed and unique among the projects", async () => {
    const fixture = await start();
    expect(errorOf(await fixture.call("cs_proj_rename", { title: "ad" }))).toBe(
      "This conversation has no project yet: call cs_proj_create first.",
    );
    const origin = {
      actor: "user" as const,
      surface: "api" as const,
      session: null,
      turn: null,
      tool_call: null,
      intent: "create",
    };
    const other = await fixture.project.createProject(
      await fixture.project.newProjectFolder("ad"),
      "ad",
      origin,
    );
    const projectId = brandString<ProjectId>(
      String(json(await fixture.call("cs_proj_create", { title: "draft" }))["project_id"]),
    );
    expect(json(await fixture.call("cs_proj_rename", { title: "  ad  " }))).toMatchObject({
      project_id: projectId,
      title: "ad 2",
      records: 1,
    });
    expect(errorOf(await fixture.call("cs_proj_rename", { title: " " }))).toContain(
      "must not be empty",
    );
    expect(fixture.project.listProjects().map((info) => [info.id, info.title])).toEqual([
      [other.id, "ad"],
      [projectId, "ad 2"],
    ]);
  });

  it("registers a reducer only for a registered component key, and registers its own key proj", async () => {
    const fixture = await start();
    expect(() => fixture.project.registerComponent("proj")).toThrow(
      expect.objectContaining({ code: "component_exists" }),
    );
    const reducer = {
      initial: () => ({ assets: {}, creators: {} }),
      reduce: <T>(slice: T) => slice,
    };
    expect(() => fixture.project.registerReducer("test_library", reducer)).toThrow(
      expect.objectContaining({ code: "invalid_params" }),
    );
    const removeComponent = fixture.project.registerComponent("test_library");
    expect(() => fixture.project.registerComponent("test_library")).toThrow(
      expect.objectContaining({ code: "component_exists" }),
    );
    fixture.project.registerReducer("test_library", reducer)();
    removeComponent();
    expect(() => fixture.project.registerReducer("test_library", reducer)).toThrow(
      expect.objectContaining({ code: "invalid_params" }),
    );
  });

  it("adds each reducer's agentSummary fields between the record count and the stale records, in component key order", async () => {
    const fixture = await start();
    fixture.project.registerOperation(still());
    fixture.project.registerComponent("test_library");
    fixture.project.registerComponent("proj_tools_test");
    // Registered before `proj_tools_test`, but its fields follow, because the summary orders the keys alphabetically.
    const removeVersions = fixture.project.registerReducer("test_library", {
      initial: () => ({ assets: {}, creators: {} }),
      reduce: (slice) => slice,
      agentSummary: (slice) => ({ versions: Object.keys(slice?.creators ?? {}).length }),
    });
    fixture.project.registerReducer("proj_tools_test", {
      initial: () => ({ assets: [] }),
      reduce: (slice, record) =>
        record.status === "done" && record.operation === "asset.crop"
          ? { assets: [...(slice?.assets ?? []), ...record.outputs] }
          : slice,
      agentSummary: (slice, assets) => ({
        stills: (slice?.assets ?? []).map((asset) => assets.url(asset)),
      }),
    });
    json(await fixture.call("cs_proj_create", { title: "summary" }));
    const made = value(await fixture.call("cs_asset_crop", { reason: "a still", prompt: "kite" }));
    const state = json(await fixture.call("cs_proj_state", {}));
    expect(Object.keys(state)).toEqual([
      "project_id",
      "title",
      "head",
      "records",
      "stills",
      "versions",
      "stale",
      "recent",
    ]);
    expect(state["stills"]).toEqual([made.outputs[0]?.url]);
    expect(state["versions"]).toBe(0);
    removeVersions();
    // A field that Project or another component already uses refuses the summary.
    fixture.project.registerReducer("test_library", {
      initial: () => ({ assets: {}, creators: {} }),
      reduce: (slice) => slice,
      agentSummary: () => ({ stale: 1 }),
    });
    expect(errorOf(await fixture.call("cs_proj_state", {}))).toContain(
      "Two project summaries use the field stale",
    );
  });

  it("lists recent records with their summaries, failures, outputs and history", async () => {
    const fixture = await start();
    const removeStill = fixture.project.registerOperation(still());
    fixture.project.registerOperation(
      still({ name: "asset.import", execute: () => Promise.reject(new Error("no such file")) }),
    );
    json(await fixture.call("cs_proj_create", { title: "recent" }));
    const made = value(await fixture.call("cs_asset_crop", { reason: "a still", prompt: "kite" }));
    expect(
      errorOf(await fixture.call("cs_asset_import", { reason: "bring it", prompt: "x" })),
    ).toContain("no such file");
    const state = json(await fixture.call("cs_proj_state", {}));
    expect(state).toMatchObject({ records: 3 });
    expect(state["recent"]).toEqual([
      expect.objectContaining({ operation: "proj.create" }),
      {
        record: made.record,
        operation: "asset.crop",
        status: "done",
        intent: "a still",
        summary: "made from kite",
        outputs: [made.outputs[0]?.url],
        based_on: null,
        supersedes: [],
      },
      expect.objectContaining({
        operation: "asset.import",
        status: "failed",
        summary: "no such file",
        outputs: [],
      }),
    ]);
    // A record whose operation is no longer registered is summarized by its operation name.
    removeStill();
    expect(
      (json(await fixture.call("cs_proj_state", {}))["recent"] as Array<{ summary: string }>)[1]
        ?.summary,
    ).toBe("asset.crop");
    expect(json(await fixture.call("cs_proj_history_list", { limit: 3 }))).toEqual([
      expect.objectContaining({
        operation: "asset.import",
        status: "failed",
        actor: "agent",
        place: "current",
      }),
      {
        record: made.record,
        place: "before",
        operation: "asset.crop",
        status: "done",
        actor: "agent",
        intent: "a still",
        outputs: [made.outputs[0]?.asset_id],
      },
      expect.objectContaining({ operation: "proj.create", actor: "agent" }),
    ]);
    expect(
      json(await fixture.call("cs_proj_history_list", { operation: "asset.crop" })),
    ).toHaveLength(1);
    expect(json(await fixture.call("cs_proj_history_list", {}))).toHaveLength(3);
  });

  it("moves back and forward without writing a record, discards the later steps on a write, and accepts a stale record only when called", async () => {
    const fixture = await start();
    fixture.project.registerOperation(still());
    const projectId = brandString<ProjectId>(
      String(json(await fixture.call("cs_proj_create", { title: "edits" }))["project_id"]),
    );
    const first = value(await fixture.call("cs_asset_crop", { reason: "first", prompt: "one" }));
    const dropped = value(
      await fixture.call("cs_asset_crop", { reason: "dropped", prompt: "drop" }),
    );
    expect(json(await fixture.call("cs_proj_state", {}))).toMatchObject({ records: 3 });
    expect(json(await fixture.call("cs_proj_undo", {}))).toMatchObject({
      records: 2,
      head: first.record,
    });
    expect(json(await fixture.call("cs_proj_redo", {}))).toMatchObject({
      records: 3,
      head: dropped.record,
    });
    expect(errorOf(await fixture.call("cs_proj_redo", {}))).toContain("no step to redo");
    // `to` moves to a step of the history, before or after the current one; a move writes no record.
    const create = fixture.project.listHistory({ project: projectId, operation: "proj.create" })[0]!
      .record.id;
    expect(json(await fixture.call("cs_proj_undo", { to: create }))).toMatchObject({ records: 1 });
    expect(json(await fixture.call("cs_proj_undo", { to: first.record }))).toMatchObject({
      records: 2,
    });
    expect(fixture.project.listRecords(projectId)).toHaveLength(3);
    expect(json(await fixture.call("cs_proj_history_list", {}))).toEqual([
      expect.objectContaining({ record: dropped.record, place: "after" }),
      expect.objectContaining({ record: first.record, place: "current" }),
      expect.objectContaining({ record: create, place: "before" }),
    ]);
    // A write after the move discards the step after the current one for good.
    const second = value(await fixture.call("cs_asset_crop", { reason: "second", prompt: "two" }));
    expect(json(await fixture.call("cs_proj_state", {}))).toMatchObject({ records: 3 });
    expect(
      json(await fixture.call("cs_proj_history_list", { operation: "asset.crop" })),
    ).toHaveLength(2);
    expect(errorOf(await fixture.call("cs_proj_undo", { to: dropped.record }))).toContain(
      "discarded",
    );
    // A consumer of a superseded output is stale until the agent accepts it.
    const consumer = value(
      await fixture.call("cs_asset_crop", {
        reason: "from the second",
        prompt: "three",
        inputs: { reference: `${second.record}#0` },
      }),
    );
    value(
      await fixture.call("cs_asset_crop", {
        reason: "rerun",
        prompt: "two again",
        supersedes: [second.record],
      }),
    );
    expect(json(await fixture.call("cs_proj_state", {}))["stale"]).toEqual([consumer.record]);
    expect(
      json(await fixture.call("cs_proj_stale_accept", { record: consumer.record }))["stale"],
    ).toEqual([]);
    expect(
      fixture.project.listHistory({ project: projectId, operation: "proj.stale_accept" })[0]?.record
        .intent,
    ).toBe(`accept ${consumer.record}`);
  });

  it("names the record a write tool wrote in its metadata, and what every summary tool showed of the project", async () => {
    const fixture = await start();
    fixture.project.registerOperation(still());
    const created = await fixture.call("cs_proj_create", { title: "meta" });
    const projectId = brandString<ProjectId>(String(json(created)["project_id"]));
    const newest = (operation: string): string =>
      fixture.project.listHistory({ project: projectId, operation })[0]?.record.id ?? "";
    expect(created.meta).toEqual({
      record: newest("proj.create"),
      cs_seen: {
        project: projectId,
        at: newest("proj.create"),
        records: { [newest("proj.create")]: "done" },
      },
    });
    const cropped = value(await fixture.call("cs_asset_crop", { reason: "first", prompt: "one" }));
    const accepted = await fixture.call("cs_proj_stale_accept", {
      record: newest("asset.crop"),
    });
    const seenAt = (at: string, ...records: string[]): unknown => ({
      project: projectId,
      at,
      records: Object.fromEntries(records.map((id) => [id, "done"])),
    });
    expect(accepted.meta).toEqual({
      record: newest("proj.stale_accept"),
      cs_seen: seenAt(
        newest("proj.stale_accept"),
        newest("proj.create"),
        cropped.record,
        newest("proj.stale_accept"),
      ),
    });
    // Undo and redo move the current position and write no record, so their metadata names no record.
    const undone = await fixture.call("cs_proj_undo", {});
    expect(json(undone)["record"]).toBeUndefined();
    expect(undone.meta).toEqual({
      cs_seen: seenAt(cropped.record, newest("proj.create"), cropped.record),
    });
    expect((await fixture.call("cs_proj_state", {})).meta).toEqual({
      cs_seen: seenAt(cropped.record, newest("proj.create"), cropped.record),
    });
    expect((await fixture.call("cs_proj_history_list", {})).meta).toBeUndefined();
  });

  it("shows a pending record by its status in the project summary", async () => {
    const fixture = await start();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.project.registerOperation(
      still({
        resource: "gpu",
        execute: async (context) => {
          await held;
          return {
            outputs: [
              context.importAsset(Buffer.from("slow"), { mime: "image/png", name: "slow.png" }),
            ],
          };
        },
      }),
    );
    const projectId = brandString<ProjectId>(
      String(json(await fixture.call("cs_proj_create", { title: "pending" }))["project_id"]),
    );
    const origin = {
      actor: "user" as const,
      surface: "api" as const,
      session: null,
      turn: null,
      tool_call: null,
      intent: "slow",
    };
    const scheduled = await fixture.project.run({
      ...origin,
      project: projectId,
      operation: "asset.crop",
      params: { prompt: "s" },
      inputs: [],
      after: [],
    });
    const pending = json(await fixture.call("cs_proj_state", {}))["recent"] as Array<{
      record: string;
      summary: string;
    }>;
    expect(pending.at(-1)?.record).toBe(scheduled.record?.id);
    expect(["pending", "running"]).toContain(pending.at(-1)?.summary);
    release();
    await fixture.project.wait(projectId);
  });

  it("cs_proj_wait reads the named records after they finish", async () => {
    const fixture = await start();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.project.registerOperation(
      still({
        resource: "gpu",
        execute: async (context) => {
          if (context.params["prompt"] === "broken") throw new Error("The ink ran out.");
          if (context.params["prompt"] === "slow") await held;
          return {
            outputs: [
              context.importAsset(Buffer.from(`still ${String(context.params["prompt"])}`), {
                mime: "image/png",
                name: "still.png",
              }),
            ],
          };
        },
      }),
    );
    const projectId = brandString<ProjectId>(
      String(json(await fixture.call("cs_proj_create", { title: "wait" }))["project_id"]),
    );
    const early = value(
      await fixture.call("cs_asset_crop", { reason: "an early still", prompt: "kite" }),
    );
    const origin = {
      actor: "system" as const,
      surface: "api" as const,
      session: null,
      turn: null,
      tool_call: null,
    };
    const scheduled = async (prompt: string, intent: string): Promise<string> => {
      const result = await fixture.project.run({
        ...origin,
        intent,
        project: projectId,
        operation: "asset.crop",
        params: { prompt },
        inputs: [],
        after: [],
      });
      return String(result.record?.id);
    };
    const slow = await scheduled("slow", "a slow still");
    const broken = await scheduled("broken", "a broken still");
    expect(errorOf(await fixture.call("cs_proj_wait", { records: [] }))).toBe(
      "Name at least one record ID to wait for.",
    );
    expect(errorOf(await fixture.call("cs_proj_wait", { records: [slow, "missing"] }))).toContain(
      `Project ${projectId} has no record missing.`,
    );
    const waiting = fixture.call("cs_proj_wait", { records: [slow, early.record, broken] });
    release();
    const result = await waiting;
    const asset = (prompt: string): string =>
      createHash("sha256").update(`still ${prompt}`).digest("hex");
    expect(result.content).toEqual([
      {
        type: "text",
        text: [
          `done ${slow} (a slow still): made from slow`,
          `- still: ${asset("slow")} (image/png) https://assets.example/${asset("slow")}`,
          `done ${early.record} (an early still): made from kite`,
          `- still: ${asset("kite")} (image/png) https://assets.example/${asset("kite")}`,
          `failed ${broken} (a broken still): The ink ran out.`,
        ].join("\n"),
      },
    ]);
    expect(json(result)).toEqual({
      project: projectId,
      records: [
        expect.objectContaining({ record: slow, status: "done" }),
        expect.objectContaining({ record: early.record, status: "done" }),
        {
          record: broken,
          status: "failed",
          intent: "a broken still",
          summary: "The ink ran out.",
          outputs: [],
        },
      ],
    });
    // The metadata names each record the result showed, in the status it showed.
    expect(result.meta).toEqual({
      cs_seen: {
        project: projectId,
        records: { [slow]: "done", [early.record]: "done", [broken]: "failed" },
      },
    });
  });
});

describe("projects as Workspace folders", () => {
  const HUMAN = {
    actor: "user" as const,
    surface: "api" as const,
    session: null,
    turn: null,
    tool_call: null,
    intent: "create",
  };

  it("makes the chat's folder a project: .comfy-studio beside the user's files, a titled Workspace, the chat attached", async () => {
    const fixture = await start();
    writeFileSync(join(fixture.chatFolder, "notes.txt"), "mine");
    const projectId = brandString<ProjectId>(
      String(json(await fixture.call("cs_proj_create", { title: "dance" }))["project_id"]),
    );
    expect(readdirSync(fixture.chatFolder).toSorted()).toEqual([".comfy-studio", "notes.txt"]);
    expect(readdirSync(join(fixture.chatFolder, ".comfy-studio")).toSorted()).toEqual([
      "line.json",
      "records.jsonl",
    ]);
    const [workspace] = fixture.services.workspaces.list();
    expect(workspace).toMatchObject({ id: projectId, title: "dance", sessionIds: ["s1"] });
    expect(fixture.project.openProject(projectId)).toEqual({
      id: projectId,
      title: "dance",
      created_at: workspace?.createdAt,
      path: workspace?.path,
    });
    // A Workspace without `.comfy-studio/records.jsonl` is no project.
    const plain = join(fixture.chatFolder, "plain");
    mkdirSync(plain);
    await fixture.services.workspaces.create(plain);
    expect(fixture.project.listProjects().map((info) => info.id)).toEqual([projectId]);
  });

  it("creates a folder's project once, finishes a create whose Workspace registration was lost, and attaches its stored chats", async () => {
    const fixture = await start();
    const folder = await fixture.project.newProjectFolder("reel");
    const first = await fixture.project.createProject(folder, "reel", HUMAN);
    expect(await fixture.project.createProject(folder, "other title", HUMAN)).toEqual(first);
    expect(fixture.services.workspaces.list()).toHaveLength(1);
    expect(fixture.project.listRecords(first.id).map((record) => record.operation)).toEqual([
      "proj.create",
    ]);

    // The Workspace registration is lost, as after a crash between the records write and the registration.
    await fixture.services.workspaces.delete(first.id);
    // A subagent child is no chat of its own, and a chat that cannot be attached leaves the project created.
    const stored = [
      { id: "s-broken", cwd: folder },
      { id: "s-old", cwd: folder },
      { id: "s-child", cwd: folder, origin: "subagent" },
    ];
    fixture.context.provide("sessionPersistence", {
      list: () => Promise.resolve(stored.map((header) => ({ header }))),
    } as never);
    fixture.services.workspaces.unattachable.add("s-broken");
    const again = await fixture.project.createProject(folder, "reel", HUMAN);
    expect(again.id).not.toBe(first.id);
    expect(fixture.project.listRecords(again.id).map((record) => record.operation)).toEqual([
      "proj.create",
    ]);
    expect(fixture.services.workspaces.get(again.id)?.sessionIds).toEqual(["s-old"]);
  });

  it("ends a create with a Workspace change after the first record, so a browser that reads the list at that change sees the project", async () => {
    const fixture = await start();
    const folder = await fixture.project.newProjectFolder("reel");
    const listedAtTitle: string[][] = [];
    const setTitle = vi.spyOn(TestWorkspace.prototype, "setTitle").mockImplementation(function (
      this: TestWorkspace,
      title: string,
    ) {
      this.title = title;
      listedAtTitle.push(fixture.project.listProjects().map((info) => info.title));
      return Promise.resolve();
    });
    await fixture.project.createProject(folder, "reel", HUMAN);
    setTitle.mockRestore();
    expect(listedAtTitle).toEqual([[], ["reel"]]);
  });

  it("removes a project's Workspace and keeps its files; a new chat in the folder makes it a project again", async () => {
    const fixture = await start();
    const projectId = brandString<ProjectId>(
      String(json(await fixture.call("cs_proj_create", { title: "dance" }))["project_id"]),
    );
    await fixture.project.removeProject(projectId);
    expect(fixture.services.workspaces.list()).toEqual([]);
    expect(fixture.project.listProjects()).toEqual([]);
    expect(fixture.project.sessionProject(brandString<SessionId>("s1"))).toBeNull();
    expect(existsSync(join(fixture.chatFolder, ".comfy-studio", "records.jsonl"))).toBe(true);

    fixture.services.chats.open("s2", fixture.chatFolder);
    const added = brandString<ProjectId>(
      String(json(await fixture.call("cs_proj_create", { title: "dance" }, "s2"))["project_id"]),
    );
    expect(added).not.toBe(projectId);
    expect(fixture.project.listRecords(added).map((record) => record.operation)).toEqual([
      "proj.create",
    ]);
    expect(fixture.services.workspaces.get(added)?.sessionIds.toSorted()).toEqual(["s1", "s2"]);
  });

  it("gives each new project folder its own name", async () => {
    const fixture = await start();
    const folders = await Promise.all([
      fixture.project.newProjectFolder("a/b"),
      fixture.project.newProjectFolder("a/b"),
    ]);
    expect(
      folders
        .map((folder) => folder.split("/").at(-1))
        .toSorted((a, b) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0)),
    ).toEqual(["a-b", "a-b 2"]);
    await expect(fixture.project.newProjectFolder(" ")).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});
