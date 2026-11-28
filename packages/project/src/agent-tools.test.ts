/**
 * The agent tools of operations and the chat session's project, through the `csProject` service with the real DSH tool
 * registry: one `cs_*` tool per registered operation, calls that run as the agent on the session's project and turn,
 * reads, held calls, input parsing, and the `cs:project` prompt section.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { brandString } from "@deepseek-ai/dsh-brand";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";
import CsProject, {
  formatInputRef,
  toolNameOf,
  versionRefOf,
  type AgentCall,
  type OperationSpec,
  type OperationToolValue,
  type ProjectId,
  type RecordId,
  type SessionId,
} from "./index.ts";
import { BY_STATE_HINT, formatToolResult } from "./agent-tools.ts";
import {
  defined,
  MemoryAssets,
  STAND_IN_COMPONENTS,
  standIn,
  tempRoot,
  testKind,
} from "./testing/support.ts";
import {
  chatProject,
  provideChatServices,
  type TestChatServices,
  callTool,
  mountTools,
} from "./testing/workspaces.ts";

declare module "@cs/project/types" {
  interface ComponentStates {
    /** The slice of the test setting that an `agent` function reads: what an agent's call of `image.generate` does. */
    tool_setting?: { agent: AgentCall };
  }
}

/** An attachment service that accepts every image. */
class MemoryAttachments {
  readonly saved: Array<{ mediaType: string }> = [];

  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }) {
    this.saved.push(input);
    return Promise.resolve({
      attachmentId: `att-${this.saved.length}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    });
  }
}

interface Fixture {
  context: Context;
  project: CsProject;
  assets: MemoryAssets;
  root: string;
  /** The stand-in Workspace registry and live sessions. */
  services: TestChatServices;
  /** Chat session → the DSH turn number the agent registry reports for it. */
  turns: Map<string, number>;
  /** Run one tool as the agent of chat session `session`. */
  call(name: string, args: Record<string, unknown>, session?: string): Promise<ToolExecutionResult>;
}

const contexts: Context[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

/**
 * Mount the DSH tool registry, an agent registry that answers the turn of a session from `turns`, and `csProject`
 * with an in-memory asset store.
 * @param root - the folder that holds the project folders; a fresh one by default.
 * @param attachments - whether an attachment service is mounted.
 * @param services - the stand-in Workspace registry and live sessions; fresh ones by default.
 * @returns the fixture.
 */
async function start(
  root = tempRoot(),
  attachments = true,
  services?: TestChatServices,
): Promise<Fixture> {
  const context = new Context();
  contexts.push(context);
  const provided = services ?? provideChatServices(context);
  if (services !== undefined) {
    context.provide("workspaceRegistry", standIn(services.workspaces));
    context.provide("sessions", standIn(services.chats));
  }
  if (attachments) context.provide("attachments", new MemoryAttachments());
  const turns = new Map<string, number>();
  // A session stands in as `{id}`; the DSH agent registry reports the session's latest turn.
  const agents = {
    turnBoundaryOf: (session: { id: string }) => ({ lastTurn: turns.get(session.id) ?? 0 }),
  };
  context.provide("agents", standIn(agents));
  await context.plugin(SystemPrompt, {}).await();
  await mountTools(context);
  await context
    .plugin(CsProject, {
      projectsFolder: join(root, "projects"),
      cpuConcurrency: 4,
      gpuConcurrency: 1,
      promptSectionOrder: 4900,
    })
    .await();
  const assets = new MemoryAssets();
  context.csProject.registerAssetStore(assets);
  for (const key of STAND_IN_COMPONENTS) context.csProject.registerComponent(key);
  let calls = 0;
  return {
    context,
    project: context.csProject,
    assets,
    root,
    services: provided,
    turns,
    call(name, args, session = "s1") {
      calls += 1;
      const agent = { id: session, session: { id: session } };
      return callTool(context, `call-${calls}`, name, args, agent);
    },
  };
}

/**
 * An operation spec with test defaults: a `reference` input that accepts versions, an optional `prompt`.
 * @param overrides - the fields to set; `name` and `component` are required.
 * @returns the spec.
 */
function operation(
  overrides: Partial<OperationSpec> & Pick<OperationSpec, "name" | "component">,
): OperationSpec {
  return {
    version: "1",
    description: "A test operation.",
    params: { prompt: { type: "string" } },
    inputs: {
      reference: { type: "image", description: "A reference.", many: true, versioned: true },
    },
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

/** A placeholder that a test replaces once the real function exists. */
const noop = (): void => undefined;

/** The value of a successful operation tool call. */
function value(result: ToolExecutionResult): OperationToolValue {
  if (result.isError) throw new Error(result.error.message);
  return standIn<OperationToolValue>(result.value);
}

/** The record origin of a project the tests create. */
const CREATE = {
  actor: "user" as const,
  surface: "api" as const,
  session: null,
  turn: null,
  tool_call: null,
  intent: "create",
};

/** A project whose folder chat session `s1` runs in. */
function boundProject(fixture: Fixture): Promise<ProjectId> {
  return chatProject(fixture.project, fixture.services, "demo", CREATE);
}

describe("agent tools", () => {
  it("names each operation's tool, registers it while the registry is mounted, and removes it with the operation", async () => {
    expect(toolNameOf({ name: "batch.item_move" })).toBe("cs_batch_item_move");
    const fixture = await start();
    const remove = fixture.project.registerOperation(
      operation({ name: "asset.crop", component: "asset" }),
    );
    const schema = fixture.context.tools.schemas().find((tool) => tool.name === "cs_asset_crop");
    expect(schema?.description).toBe("A test operation.");
    expect(
      Object.keys(
        standIn<{ properties: object } | undefined>(schema?.parameters)?.properties ?? {},
      ).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual(["based_on", "inputs", "prompt", "reason", "supersedes"]);
    // The description ends with the resource hint and, for a read or a deterministic operation, how calls reuse work.
    const removeGenerate = fixture.project.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        resource: "gpu",
        deterministic: true,
      }),
    );
    const removeRead = fixture.project.registerOperation(
      operation({
        name: "inspect.asset",
        component: "inspect",
        resource: "cpu",
        readOnly: true,
        outputs: [],
      }),
    );
    const descriptionOf = (name: string): string | undefined =>
      fixture.context.tools.schemas().find((tool) => tool.name === name)?.description;
    expect(descriptionOf("cs_image_generate")).toBe(
      "A test operation. Uses the GPU. Repeating a call with the same inputs and params reuses the earlier result.",
    );
    expect(descriptionOf("cs_inspect_asset")).toBe(
      "A test operation. Runs on the CPU. A read that writes no record.",
    );
    removeGenerate();
    removeRead();
    remove();
    expect(fixture.context.tools.get("cs_asset_crop")).toBeUndefined();
    expect(fixture.project.listOperations()).toEqual([]);
  });

  it("registers a tool for each agent call: run and propose have one, none has none", async () => {
    const fixture = await start();
    fixture.project.registerOperation(
      operation({ name: "asset.delete", component: "asset", agent: "propose", resource: "cpu" }),
    );
    fixture.project.registerOperation(
      operation({ name: "asset.keep", component: "asset", agent: "none" }),
    );
    fixture.project.registerOperation(
      operation({ name: "asset.crop", component: "asset", agent: "run" }),
    );
    const names = fixture.context.tools.schemas().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["cs_asset_delete", "cs_asset_crop"]));
    expect(names).not.toContain("cs_asset_keep");
    expect(
      fixture.context.tools.schemas().find((tool) => tool.name === "cs_asset_delete"),
    ).toMatchObject({
      description:
        "A test operation. Runs on the CPU. Calling this tool does not run it: the call writes a proposal that the " +
        "user accepts or rejects in the app.",
    });
    // A rebuild of every tool (a new reference kind) still leaves the none operation without one.
    fixture.project.registerComponent("test_library");
    fixture.project.registerReferenceKind(testKind("test_style"));
    expect(fixture.context.tools.get("cs_asset_keep")).toBeUndefined();
    expect(fixture.context.tools.get("cs_asset_delete")).toBeDefined();
  });

  it("writes a proposal for a call of a propose tool, runs nothing, and shows the proposal as done", async () => {
    const fixture = await start();
    let runs = 0;
    fixture.project.registerOperation(
      operation({
        name: "asset.delete",
        component: "asset",
        agent: "propose",
        execute: () => {
          runs += 1;
          return Promise.resolve({ outputs: [] });
        },
      }),
    );
    const projectId = await boundProject(fixture);
    const line = fixture.project.line(projectId);
    const asset = fixture.assets.importAsset(projectId, Buffer.from("knife"), {
      mime: "image/png",
      name: "knife.png",
    });
    const result = await fixture.call("cs_asset_delete", {
      reason: "the user wants the knife gone",
      prompt: "knife",
      inputs: { reference: asset },
    });
    const proposed = value(result);
    expect(proposed).toEqual({
      project: projectId,
      record: expect.any(String),
      status: "proposed",
      summary:
        "the call of cs_asset_delete waits for the user to accept or reject it in the app; nothing has changed " +
        "yet. The user's decision reaches you as a project update; do not propose the same call again while it waits.",
      outputs: [],
      scheduled: [],
      params: { prompt: "knife" },
    });
    expect(result.isError ? [] : result.content).toEqual([
      {
        type: "text",
        text: `proposed ${proposed.record}: ${proposed.summary}\nparams: {"prompt":"knife"}`,
      },
    ]);
    expect(result.meta).toEqual({
      record: proposed.record,
      tool: "asset.delete",
      status: "proposed",
      outputs: [],
      cs_seen: { project: projectId, records: { [proposed.record]: "done" } },
    });
    expect(runs).toBe(0);
    expect(fixture.project.line(projectId)).toEqual(line);
    const record = fixture.project.getRecord(projectId, brandString<RecordId>(proposed.record));
    expect(record).toMatchObject({
      operation: "proj.propose",
      actor: "agent",
      session: "s1",
      intent: "the user wants the knife gone",
      params: { operation: "asset.delete", params: { prompt: "knife" } },
    });
    // The same proposal again folds into the pending one.
    const again = value(
      await fixture.call("cs_asset_delete", {
        reason: "again",
        prompt: "knife",
        inputs: { reference: asset },
      }),
    );
    expect(again.record).toBe(proposed.record);
    // A proposal that its checks refuse is a tool error and writes nothing.
    const records = fixture.project.listRecords(projectId).length;
    const refused = await fixture.call("cs_asset_delete", {
      reason: "a missing asset",
      prompt: "knife",
      inputs: { reference: "f".repeat(64) },
    });
    expect(refused.isError && refused.error.message).toBe(
      `Input 'reference' names an unknown asset ${"f".repeat(64)}.`,
    );
    expect(fixture.project.listRecords(projectId)).toHaveLength(records);
  });

  it("proposes or runs a call by the project's state when the operation's agent call is a function", async () => {
    const fixture = await start();
    fixture.project.registerComponent("tool_setting");
    fixture.project.registerReducer("tool_setting", {
      initial: () => ({ agent: "propose" as const }),
      reduce: (slice, record) =>
        record.operation === "tool_setting.choose"
          ? { agent: standIn<AgentCall>(record.params["agent"]) }
          : slice,
    });
    fixture.project.registerOperation({
      ...operation({ name: "tool_setting.choose", component: "tool_setting", agent: "none" }),
      params: { agent: { type: "string", required: true } },
      inputs: {},
      outsideHistory: true,
    });
    let runs = 0;
    fixture.project.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        resource: "gpu",
        agent: (state) => state.components.tool_setting?.agent ?? "propose",
        execute: (context) => {
          runs += 1;
          return Promise.resolve({
            outputs: [
              context.importAsset(Buffer.from(`run ${String(runs)}`), {
                mime: "image/png",
                name: "run.png",
              }),
            ],
          });
        },
      }),
    );
    expect(fixture.context.tools.get("cs_tool_setting_choose")).toBeUndefined();
    expect(
      fixture.context.tools.schemas().find((tool) => tool.name === "cs_image_generate")
        ?.description,
    ).toBe(`A test operation. Uses the GPU. ${BY_STATE_HINT}`);
    expect(BY_STATE_HINT).toBe(
      "Whether this call runs or only writes a proposal depends on the project's settings; the result's status says which.",
    );
    const projectId = await boundProject(fixture);
    const choose = (agent: AgentCall) =>
      fixture.project.run({
        ...CREATE,
        project: projectId,
        operation: "tool_setting.choose",
        params: { agent },
        inputs: [],
      });

    // The default setting proposes.
    const proposed = value(
      await fixture.call("cs_image_generate", { reason: "a kite", prompt: "kite" }),
    );
    expect(proposed).toMatchObject({ status: "proposed", outputs: [], scheduled: [] });
    expect(runs).toBe(0);
    expect(
      fixture.project.getRecord(projectId, brandString<RecordId>(proposed.record)).operation,
    ).toBe("proj.propose");

    // The user lets the agent run it: the next call runs as the agent.
    await choose("run");
    const ran = value(
      await fixture.call("cs_image_generate", { reason: "a kite", prompt: "kite" }),
    );
    expect(ran).toMatchObject({ status: "done", summary: "made from kite" });
    expect(runs).toBe(1);
    expect(fixture.project.getRecord(projectId, brandString<RecordId>(ran.record))).toMatchObject({
      operation: "image.generate",
      actor: "agent",
    });

    // The user takes agent calls away: the tool stays and its call is refused as run refuses it, writing nothing.
    await choose("none");
    const records = fixture.project.listRecords(projectId).length;
    const refused = await fixture.call("cs_image_generate", { reason: "a kite", prompt: "kite" });
    expect(refused.isError && refused.error.message).toBe(
      "An agent cannot call image.generate; only the user runs it.",
    );
    expect(fixture.project.listRecords(projectId)).toHaveLength(records);
    expect(fixture.context.tools.get("cs_image_generate")).toBeDefined();
  });

  it("answers a call of a background operation with its pending record, shown as a scheduled call is", async () => {
    const fixture = await start();
    const projectId = await boundProject(fixture);
    let release = noop;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.project.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        resource: "gpu",
        background: true,
        execute: async (context) => {
          await held;
          return {
            outputs: [
              context.importAsset(Buffer.from("later"), { mime: "image/png", name: "later.png" }),
            ],
          };
        },
      }),
    );
    const result = await fixture.call("cs_image_generate", { reason: "later", prompt: "kite" });
    const pending = value(result);
    expect(pending).toEqual({
      project: projectId,
      record: expect.any(String),
      status: "pending",
      summary: "cs_image_generate pending",
      outputs: [],
      scheduled: [],
      params: { prompt: "kite" },
    });
    expect(result.isError ? [] : result.content).toEqual([
      {
        type: "text",
        text: `pending ${pending.record}: cs_image_generate pending\nparams: {"prompt":"kite"}`,
      },
    ]);
    expect(result.meta).toEqual({
      record: pending.record,
      tool: "image.generate",
      status: "pending",
      outputs: [],
      cs_seen: {
        project: projectId,
        at: pending.record,
        records: { [pending.record]: "pending" },
      },
    });
    const id = brandString<RecordId>(pending.record);
    expect(fixture.project.getRecord(projectId, id).status).not.toBe("done");
    release();
    await fixture.project.wait(projectId, [id]);
    expect(fixture.project.getRecord(projectId, id).status).toBe("done");
  });

  it("refuses a call with an argument the tool does not declare, such as a project, before any record", async () => {
    const fixture = await start();
    fixture.project.registerOperation(operation({ name: "asset.crop", component: "asset" }));
    const projectId = await boundProject(fixture);
    const stray = await fixture.call("cs_asset_crop", {
      reason: "elsewhere",
      prompt: "x",
      project_id: "other",
    });
    expect(stray.isError && stray.error.message).toBe("cs_asset_crop has no argument project_id.");
    expect(fixture.project.listHistory({ project: projectId, operation: "asset.crop" })).toEqual(
      [],
    );
  });

  it("runs a call as the agent on its conversation's project and turn, and describes the record with URLs and images", async () => {
    const fixture = await start();
    fixture.project.registerOperation(operation({ name: "asset.crop", component: "asset" }));
    const refused = await fixture.call("cs_asset_crop", {
      reason: "no project yet",
      prompt: "x",
    });
    expect(refused.isError && refused.error.message).toBe(
      "This conversation has no project yet: call cs_proj_create first.",
    );
    const projectId = await boundProject(fixture);
    fixture.turns.set("s1", 3);
    const result = await fixture.call("cs_asset_crop", {
      reason: "the kite",
      prompt: "kite",
    });
    const cropped = value(result);
    const record = fixture.project.getRecord(projectId, brandString<RecordId>(cropped.record));
    expect(record).toMatchObject({
      actor: "agent",
      surface: "chat",
      session: "s1",
      turn: "3",
      tool_call: "call-2",
      intent: "the kite",
      params: { prompt: "kite" },
    });
    expect(cropped).toMatchObject({
      status: "done",
      summary: "made from kite",
      scheduled: [],
      params: { prompt: "kite" },
      outputs: [
        { role: "still", mime: "image/png", url: `https://assets.example/${record.outputs[0]}` },
      ],
    });
    expect(cropped.images).toHaveLength(1);
    expect(result.content.filter((block) => block.type === "image")).toHaveLength(1);
    expect(result.meta).toMatchObject({
      record: cropped.record,
      tool: "asset.crop",
      status: "done",
      cs_seen: { project: projectId, at: cropped.record, records: { [cropped.record]: "done" } },
    });
    // An empty reason falls back to the operation name; based_on and supersedes reach the record.
    const again = value(
      await fixture.call("cs_asset_crop", {
        reason: "",
        prompt: "kite 2",
        based_on: cropped.record,
        supersedes: [cropped.record],
      }),
    );
    expect(fixture.project.getRecord(projectId, brandString<RecordId>(again.record))).toMatchObject(
      { intent: "asset.crop", based_on: cropped.record, supersedes: [cropped.record] },
    );
    // A failed record is a tool error with the failure message.
    fixture.project.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        execute: () => Promise.reject(new Error("out of memory")),
      }),
    );
    const failed = await fixture.call("cs_image_generate", { reason: "generate", prompt: "x" });
    expect(failed.isError && failed.error.message).toBe("out of memory");
    // An input error of a tool call names the tool, never the operation.
    const unknownRole = await fixture.call("cs_image_generate", {
      reason: "generate",
      prompt: "x",
      inputs: { other: "a1" },
    });
    expect(unknownRole.isError && unknownRole.error.message).toBe(
      'Unknown input role "other" for cs_image_generate; roles: reference.',
    );
  });

  it("answers a read with its report and writes nothing; lists outputs without images when no attachment service is mounted", async () => {
    const fixture = await start(tempRoot(), false);
    const projectId = await boundProject(fixture);
    fixture.project.registerOperation(
      operation({
        name: "inspect.asset",
        component: "inspect",
        readOnly: true,
        outputs: [],
        execute: (context) =>
          Promise.resolve({ outputs: [], report: { prompt: context.params["prompt"] } }),
      }),
    );
    const before = fixture.project.listHistory({ project: projectId }).length;
    const read = await fixture.call("cs_inspect_asset", { reason: "look", prompt: "p" });
    expect(value(read)).toMatchObject({
      record: "",
      status: "done",
      summary: "cs_inspect_asset answered",
      report: { prompt: "p" },
    });
    const text = read.content.find((block) => block.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      'done: cs_inspect_asset answered\nparams: {"prompt":"p"}\nreport: {"prompt":"p"}',
    );
    expect(
      Object.keys(
        standIn<{ properties: object } | undefined>(
          fixture.context.tools.schemas().find((tool) => tool.name === "cs_inspect_asset")
            ?.parameters,
        )?.properties ?? {},
      ),
    ).not.toContain("supersedes");
    expect(fixture.project.listHistory({ project: projectId })).toHaveLength(before);
    fixture.project.registerOperation(operation({ name: "asset.crop", component: "asset" }));
    expect(
      value(await fixture.call("cs_asset_crop", { reason: "still", prompt: "q" })).images,
    ).toBeUndefined();
  });

  it("lets an operation prepare its call, keeps tool-only arguments out of params, and schedules behind unfinished producers", async () => {
    const fixture = await start();
    const projectId = await boundProject(fixture);
    let release = noop;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.project.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        execute: async (context) => {
          await held;
          return {
            outputs: [
              context.importAsset(Buffer.from("variant"), {
                mime: "video/mp4",
                name: "variant.mp4",
              }),
            ],
          };
        },
      }),
    );
    fixture.project.registerOperation(
      operation({
        name: "asset.crop",
        component: "asset",
        toolParams: { from_variant: { type: "string", description: "A variant record." } },
        prepareToolCall: (call) => {
          const from = call.args["from_variant"];
          if (typeof from === "string")
            call.request.inputs.push({
              role: "reference",
              ref: { record: brandString<RecordId>(from), output: 0 },
            });
          return Promise.resolve();
        },
      }),
    );
    const generating = fixture.call("cs_image_generate", { reason: "variant", prompt: "r" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const variant = defined(
      fixture.project.listHistory({
        project: projectId,
        operation: "image.generate",
      })[0]?.record.id,
      "the variant record",
    );
    const still = value(
      await fixture.call("cs_asset_crop", {
        reason: "still of the variant",
        prompt: "s",
        from_variant: variant,
      }),
    );
    expect(still).toMatchObject({
      status: "pending",
      summary: "cs_asset_crop pending",
      outputs: [],
      params: { prompt: "s" },
    });
    expect(
      fixture.project.getRecord(projectId, brandString<RecordId>(still.record)).inputs,
    ).toEqual([{ role: "reference", ref: { record: variant, output: 0 }, resolved_asset: null }]);
    release();
    await generating;
    await fixture.project.wait(projectId);
    expect(fixture.project.getRecord(projectId, brandString<RecordId>(still.record)).status).toBe(
      "done",
    );
  });

  it("records no turn for a call outside any turn", async () => {
    const fixture = await start();
    const projectId = await boundProject(fixture);
    fixture.project.registerOperation(operation({ name: "asset.crop", component: "asset" }));
    const cropped = value(await fixture.call("cs_asset_crop", { reason: "still", prompt: "a" }));
    expect(
      fixture.project.getRecord(projectId, brandString<RecordId>(cropped.record)).turn,
    ).toBeNull();
  });

  it("gives the agent the cs:project prompt section: Project's rules, the same text for an unbound and a bound conversation", async () => {
    const fixture = await start();
    fixture.project.registerOperation(operation({ name: "asset.crop", component: "asset" }));
    const sectionOf = async (session: string): Promise<string | undefined> => {
      const assembly = await fixture.context.systemPrompt.assemble({
        agent: standIn({ id: session }),
      });
      return assembly.sections.find((section) => section.name === "cs:project")?.text;
    };
    const unbound = await sectionOf("s1");
    expect(unbound).toContain("Project rules:");
    expect(unbound).toContain(
      "- A conversation without a project starts the work with cs_proj_create. Once the project " +
        "state message or cs_proj_create names this conversation's project, do all work in it and never call cs_proj_create " +
        "again. Changes of the project that your own tool results did not show reach you as project updates; " +
        "cs_proj_state reads the whole project at any time.",
    );
    expect(unbound).toContain(
      "- Every call of yours, except a call of a tool whose description says it writes a proposal, and every edit " +
        "of the user is a step of the project history at once; the user does not accept those changes.",
    );
    expect(unbound).toContain(
      "- A tool whose description says the call writes a proposal changes nothing: the user accepts or rejects the " +
        "proposal in the app, and only an accepted proposal runs. Say in your reply what you proposed, then wait for " +
        "the decision, which reaches you as a project update; never repeat a proposal that waits.",
    );
    expect(unbound).toContain("cs_proj_redo goes forward one step. These moves add no step.");
    expect(unbound).toContain(
      "A new change after a move discards the steps after the current one for good",
    );
    expect(unbound).not.toMatch(/branch/);
    await boundProject(fixture);
    expect(await sectionOf("s1")).toBe(unbound);
    await fixture.call("cs_asset_crop", { reason: "still", prompt: "a" });
    expect(await sectionOf("s1")).toBe(unbound);
  });

  it("names the registered reference kinds in the naming rule of the cs:project prompt section", async () => {
    const fixture = await start();
    const section = async (): Promise<string | undefined> =>
      (await fixture.context.systemPrompt.assemble({ agent: standIn({ id: "s1" }) })).sections.find(
        (entry) => entry.name === "cs:project",
      )?.text;
    expect(await section()).toContain(
      "an output of a record as <record>#<n>, an asset by its asset ID, and any other item by the ID",
    );
    fixture.project.registerComponent("test_library");
    const removeLocation = fixture.project.registerReferenceKind(testKind("test_location"));
    fixture.project.registerReferenceKind(testKind("test_style"));
    expect(await section()).toContain(
      "<record>#<n>, a test_location or test_style version as <id>@<version>, an asset by its asset ID",
    );
    removeLocation();
    expect(await section()).toContain(
      "<record>#<n>, a test_style version as <id>@<version>, an asset by its asset ID",
    );
  });

  it("holds a session's calls until its held work settles, even when that work fails", async () => {
    const fixture = await start();
    await boundProject(fixture);
    fixture.project.registerOperation(operation({ name: "asset.crop", component: "asset" }));
    const order: string[] = [];
    let finish = noop;
    const work = new Promise<void>((_resolve, reject) => {
      finish = () => {
        order.push("work");
        reject(new Error("import failed"));
      };
    });
    fixture.project.holdToolCalls(brandString<SessionId>("s1"), work);
    const call = fixture
      .call("cs_asset_crop", { reason: "after the import", prompt: "a" })
      .then((result) => {
        order.push("call");
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual([]);
    finish();
    expect(value(await call).status).toBe("done");
    expect(order).toEqual(["work", "call"]);
  });

  it("registers reference kinds of registered components, and lists them in the inputs text of every tool", async () => {
    const fixture = await start();
    fixture.project.registerOperation(operation({ name: "asset.crop", component: "asset" }));
    const inputsText = () =>
      JSON.stringify(
        fixture.context.tools.schemas().find((tool) => tool.name === "cs_asset_crop")?.parameters,
      );
    expect(inputsText()).toContain(
      "<asset> (an asset ID), <record>#<output> (an output of an earlier record); a list",
    );
    expect(() => fixture.project.registerReferenceKind(testKind("test_location"))).toThrow(
      expect.objectContaining({ code: "invalid_params" }),
    );
    fixture.project.registerComponent("test_library");
    // The other arms of an input reference use these keys, so no kind may take one.
    for (const reserved of ["asset", "record", "version"]) {
      expect(() => fixture.project.registerReferenceKind(testKind(reserved))).toThrow(
        expect.objectContaining({ code: "invalid_params" }),
      );
    }
    expect(fixture.project.listReferenceKinds()).toEqual([]);
    const removeLocation = fixture.project.registerReferenceKind(testKind("test_location"));
    expect(inputsText()).toContain(
      "or <id>@<version> (a test_location version; cs_proj_state lists IDs); a list",
    );
    fixture.project.registerReferenceKind(testKind("test_style"));
    fixture.project.registerReferenceKind(testKind("test_character"));
    expect(fixture.project.listReferenceKinds()).toEqual([
      "test_location",
      "test_style",
      "test_character",
    ]);
    expect(inputsText()).toContain(
      "(a test_location, test_style or test_character version; cs_proj_state lists IDs)",
    );
    expect(() => fixture.project.registerReferenceKind(testKind("test_style"))).toThrow(
      expect.objectContaining({ code: "kind_exists" }),
    );
    removeLocation();
    expect(inputsText()).toContain(
      "(a test_style or test_character version; cs_proj_state lists IDs)",
    );
  });

  it("parses input references: assets, record outputs, and versions of the one reference kind that has them", async () => {
    const fixture = await start();
    const projectId = await boundProject(fixture);
    fixture.project.registerOperation(
      operation({
        name: "image.generate",
        component: "image",
        inputs: {
          first_frame: { type: "image", description: "A frame.", required: true },
          reference: { type: "image", description: "refs", many: true, versioned: true },
        },
      }),
    );
    fixture.project.registerOperation(
      operation({ name: "library.create", component: "library", inputs: {} }),
    );
    const creators: Record<string, RecordId> = {
      "test_location:l1@2": brandString<RecordId>("r-location"),
      "test_location:dup@1": brandString<RecordId>("r1"),
      "test_style:dup@1": brandString<RecordId>("r2"),
    };
    fixture.project.registerComponent("test_library");
    fixture.project.registerReducer("test_library", {
      initial: () => ({ assets: {}, creators }),
      reduce: (slice) => slice,
    });
    const state = fixture.project.getState(projectId);
    expect(() => fixture.project.parseReference("l1@2", state)).toThrow(
      "Unknown version 'l1@2'; reference kinds: none.",
    );
    fixture.project.registerReferenceKind(testKind("test_location"));
    fixture.project.registerReferenceKind(testKind("test_style"));
    const parse = (name: string, raw: unknown) => fixture.project.parseInputs(name, raw, state);
    expect(parse("image.generate", { first_frame: "r1#1", reference: ["a1", "l1@2"] })).toEqual([
      { role: "first_frame", ref: { record: "r1", output: 1 } },
      { role: "reference", ref: { asset: "a1" } },
      { role: "reference", ref: { test_location: "l1", version: 2 } },
    ]);
    expect(fixture.project.parseReference("l1@2", state)).toEqual({
      test_location: "l1",
      version: 2,
    });
    expect(() => parse("image.generate", { first_frame: "a", reference: "nobody@1" })).toThrow(
      expect.objectContaining({
        code: "invalid_inputs",
        message: "Unknown version 'nobody@1'; reference kinds: test_location, test_style.",
      }),
    );
    expect(() => fixture.project.parseReference("dup@1", state)).toThrow(
      expect.objectContaining({
        code: "invalid_inputs",
        message: "Version 'dup@1' names more than one reference kind: test_location, test_style.",
      }),
    );
    // A view request names the operation by default; the caller can name the call another way, as the agent tool does.
    expect(() => parse("image.generate", undefined)).toThrow(
      'image.generate needs input "first_frame"',
    );
    expect(() =>
      fixture.project.parseInputs(
        "image.generate",
        { first_frame: "a", other: "b" },
        state,
        "cs_image_generate",
      ),
    ).toThrow('Unknown input role "other" for cs_image_generate');
    expect(() => parse("image.generate", "a")).toThrow("must be an object");
    expect(() => parse("image.generate", ["a"])).toThrow("must be an object");
    expect(() => parse("image.generate", { first_frame: ["a", "b"] })).toThrow(
      "takes one reference",
    );
    expect(() => parse("image.generate", { first_frame: 1 })).toThrow(
      "must be <asset>, <record>#<output>, or <id>@<version>",
    );
    expect(() => parse("image.generate", { first_frame: "a", other: "b" })).toThrow(
      'Unknown input role "other"',
    );
    expect(() => parse("library.create", { first_frame: "a" })).toThrow("roles: none");
    expect(() => parse("no.such", {})).toThrow(
      expect.objectContaining({ code: "unknown_operation" }),
    );
    // formatInputRef writes each reference form as the text parseInputs reads back.
    const inputs = parse("image.generate", { first_frame: "r1#1", reference: ["a1", "l1@2"] });
    const texts = inputs.map((input) => formatInputRef(input.ref));
    expect(texts).toEqual(["r1#1", "a1", "l1@2"]);
    expect(parse("image.generate", { first_frame: texts[0], reference: texts.slice(1) })).toEqual(
      inputs,
    );
    expect(inputs.map((input) => versionRefOf(input.ref))).toEqual([
      null,
      null,
      { kind: "test_location", id: "l1", version: 2 },
    ]);
    // A reference without a kind key, which no typed caller builds, names no version.
    expect([
      versionRefOf(standIn({ version: 1 })),
      formatInputRef(standIn({ version: 1 })),
    ]).toEqual([null, '{"version":1}']);
  });
});

describe("the chat session's project and the asset store", () => {
  it("finds a session's project by its folder, across a restart, and only while the folder is a project", async () => {
    const root = tempRoot();
    const first = await start(root);
    const projectId = await boundProject(first);
    await first.context.fiber.dispose();
    contexts.splice(0);
    const second = await start(root, true, first.services);
    expect(second.project.sessionProject(brandString<SessionId>("s1"))).toBe(projectId);
    // A chat that is not live, a chat in a folder that is no Workspace, and a chat in a Workspace without records.
    expect(second.project.sessionProject(brandString<SessionId>("s2"))).toBeNull();
    const plain = join(root, "plain");
    mkdirSync(plain);
    second.services.chats.open("s3", plain);
    expect(second.project.sessionProject(brandString<SessionId>("s3"))).toBeNull();
    await second.services.workspaces.create(plain);
    expect(second.project.sessionProject(brandString<SessionId>("s3"))).toBeNull();
    await second.project.removeProject(projectId);
    expect(second.project.sessionProject(brandString<SessionId>("s1"))).toBeNull();
  });

  it("fails a run that needs the asset store while no asset store is registered", async () => {
    const fixture = await start();
    const projectId = await boundProject(fixture);
    // A later registration replaces the store; its disposer leaves no store behind.
    const removeOther = fixture.project.registerAssetStore(new MemoryAssets());
    removeOther();
    fixture.project.registerOperation(operation({ name: "asset.crop", component: "asset" }));
    const origin = {
      actor: "user" as const,
      surface: "api" as const,
      session: null,
      turn: null,
      tool_call: null,
      intent: "still",
    };
    const result = await fixture.project.run({
      ...origin,
      project: projectId,
      operation: "asset.crop",
      params: { prompt: "z" },
      inputs: [],
    });
    expect(result.record).toMatchObject({
      status: "failed",
      error: {
        message:
          "No asset store is registered with csProject, so the project cannot hold assets yet.",
      },
    });
  });

  it("formats a result as text plus image blocks, with its params unless the operation omits them", () => {
    const base: OperationToolValue = {
      project: "p1",
      record: "r1",
      status: "done",
      summary: "did it",
      outputs: [{ role: "video", asset_id: "a1", mime: "video/mp4", url: "/a1" }],
      scheduled: ["r2"],
      params: { seed: 1 },
    };
    expect(formatToolResult(base, {})).toEqual([
      {
        type: "text",
        text: 'done r1: did it\n- video: a1 (video/mp4) /a1\nscheduled: r2\nparams: {"seed":1}',
      },
    ]);
    expect(formatToolResult(base, { omitParamsFromResult: true })).toEqual([
      { type: "text", text: "done r1: did it\n- video: a1 (video/mp4) /a1\nscheduled: r2" },
    ]);
    const withImages = formatToolResult(
      {
        ...base,
        scheduled: [],
        images: [
          { attachmentId: "att", mediaType: "image/png" },
          "junk",
          null,
          ["x"],
          { attachmentId: 3 },
        ],
      },
      {},
    );
    expect(withImages).toHaveLength(2);
    expect(withImages[1]).toMatchObject({ type: "image", attachment: { attachmentId: "att" } });
  });
});
