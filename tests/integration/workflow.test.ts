// The workflow component (@cs/workflow, stage 2-3c, docs/archive/PLAN_2-3c.md) on a real dsh: a
// page that logged in uploads a graph file and makes a workflow from it, the agent reads the graph
// as text and saves a patched graph as a variant while the original stays as it was, and the
// agent's delete waits for the user.

import type { Page } from "playwright-core";
import { afterEach, expect, test } from "vitest";
import type { FakeReply, FakeScript } from "../harness/llm.ts";
import {
  WORKFLOW_TOOLS,
  afterTool,
  agentRequests,
  createProject,
  isTitleRequest,
  removeTempFiles,
  seeText,
  send,
  turnOf,
  visibleChat,
  waitIdle,
  withChat,
} from "./chat-rig.ts";
import type { ListedProject } from "./chat-rig.ts";

afterEach(removeTempFiles);

/** A small text-to-image graph in ComfyUI's API format. */
const GRAPH = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a red fox", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["4", 1] } },
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 7,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "fox", images: ["8", 0] } },
};
const GRAPH_BASE64 = Buffer.from(JSON.stringify(GRAPH)).toString("base64");

interface Answer<T> {
  status: number;
  body: T;
}

/** A turn that calls one tool and then says `done`. */
function call(
  request: Parameters<FakeScript>[0],
  name: string,
  args: Record<string, unknown>,
  done: string,
): FakeReply {
  return afterTool(request) ? { text: done } : { toolCalls: [{ name, arguments: args }] };
}

interface WireWorkflow {
  id: string;
  name: string;
  graph: string;
  parent: string | null;
  nodes: number;
  fields: Array<{ id: string }>;
}

interface WireStateBody {
  components: {
    proj: { proposals: Record<string, { id: string; operation: string; status: string }> };
    workflow: { items: Record<string, WireWorkflow> };
    asset: { items: Record<string, unknown> };
  };
}

function stateOf(page: Page, project: ListedProject): Promise<WireStateBody> {
  return page.evaluate<WireStateBody>(
    `fetch("/api/cs/state?project=${project.id}").then((response) => response.json())`,
  );
}

function postBytes<T>(page: Page, path: string, base64: string): Promise<Answer<T>> {
  return page.evaluate<Answer<T>>(
    `fetch(${JSON.stringify(path)}, {
      method: "POST",
      body: Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0)),
    }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
  );
}

function postJson<T>(page: Page, path: string, body: unknown): Promise<Answer<T>> {
  return page.evaluate<Answer<T>>(
    `fetch(${JSON.stringify(path)}, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ${JSON.stringify(JSON.stringify(body))},
    }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
  );
}

/** The stored graph of a workflow, as the page reads it. */
function graphOf(page: Page, asset: string): Promise<typeof GRAPH> {
  return page.evaluate<typeof GRAPH>(
    `fetch("/api/cs/asset?id=${asset}", { cache: "no-store" }).then((response) => response.json())`,
  );
}

test("a page makes a workflow from a file, and the agent reads it and saves a patched variant", async () => {
  /** The workflow the page made, which the script's tool calls name. */
  let workflow = "";
  const script: FakeScript = (request): FakeReply => {
    if (isTitleRequest(request)) return { text: "Workflow chat" };
    switch (turnOf(request)) {
      case "read":
        return call(
          request,
          "cs_workflow_graph",
          { workflow, reason: "see the nodes" },
          "read the graph",
        );
      case "variant":
        return call(
          request,
          "cs_workflow_save_variant",
          {
            workflow,
            ops: [{ op: "set", node: "3", input: "steps", value: 30 }],
            name: "more steps",
            reason: "the user wants more steps",
          },
          "saved the variant",
        );
      case "delete":
        return call(
          request,
          "cs_workflow_delete",
          { workflow, reason: "the user wants it gone" },
          "asked to delete",
        );
      default:
        return { text: "plain reply" };
    }
  };

  await withChat(script, async ({ llm, session, page }) => {
    const project = await createProject(page);
    const chat = visibleChat(page);

    // The page uploads the file (stored, not in the asset library) and makes a workflow from it.
    const staged = await postBytes<{ asset: string }>(
      page,
      `/api/cs/asset/stage?project=${project.id}&name=fox.json&mime=${encodeURIComponent("application/json")}`,
      GRAPH_BASE64,
    );
    expect(staged.status).toBe(200);
    const created = await postJson<{ id: string; status: string; actor: string }>(
      page,
      "/api/cs/operation",
      {
        project: project.id,
        operation: "workflow.create",
        params: {},
        inputs: [{ role: "file", ref: staged.body.asset }],
        surface: "view",
      },
    );
    expect(created).toMatchObject({ status: 200, body: { status: "done", actor: "user" } });
    workflow = created.body.id;

    const made = await stateOf(page, project);
    const original = made.components.workflow.items[workflow];
    expect(original).toMatchObject({ id: workflow, name: "fox", parent: null, nodes: 7 });
    if (original === undefined) throw new Error("The workflow is not in the state.");
    // Without a server to ask, the suggested fields are read from the graph alone.
    expect(original.fields.map((field) => field.id)).toEqual(
      expect.arrayContaining(["6.text", "3.seed"]),
    );
    // Neither the uploaded file nor the stored graph is a library asset.
    expect(made.components.asset.items).toEqual({});
    expect(await graphOf(page, original.graph)).toEqual(GRAPH);

    // The agent reads the graph as text.
    await send(page, "cs-turn:read look at the workflow");
    await seeText(chat, "read the graph");
    await waitIdle(page);
    const [first, second] = agentRequests(llm, "read");
    if (first === undefined || second === undefined) throw new Error("The turn made no request.");
    expect(first.tools).toEqual(expect.arrayContaining(WORKFLOW_TOOLS));
    for (const tool of ["cs_workflow_create", "cs_workflow_update", "cs_workflow_copy"]) {
      expect(first.tools).not.toContain(tool);
    }
    expect(second.messages.at(-1)).toMatchObject({ role: "tool" });
    expect(second.messages.at(-1)?.text).toContain("KSampler");
    expect(second.messages.at(-1)?.text).toContain("steps");

    // The agent saves a patched graph as a variant; the original keeps its graph.
    await send(page, "cs-turn:variant make it slower and better");
    await seeText(chat, "saved the variant");
    await waitIdle(page);
    const after = await stateOf(page, project);
    const items = Object.values(after.components.workflow.items);
    expect(items).toHaveLength(2);
    const variant = items.find((item) => item.parent === workflow);
    expect(variant).toMatchObject({ name: "more steps", nodes: 7 });
    if (variant === undefined) throw new Error("The variant is not in the state.");
    expect(after.components.workflow.items[workflow]?.graph).toBe(original.graph);
    expect(variant.graph).not.toBe(original.graph);
    expect((await graphOf(page, variant.graph))["3"].inputs.steps).toBe(30);
    expect((await graphOf(page, original.graph))["3"].inputs.steps).toBe(20);

    // The agent's delete is a proposal: both workflows stay until the user decides.
    await send(page, "cs-turn:delete remove the first workflow");
    await seeText(chat, "asked to delete");
    await waitIdle(page);
    const proposed = await stateOf(page, project);
    expect(Object.keys(proposed.components.workflow.items)).toHaveLength(2);
    expect(Object.values(proposed.components.proj.proposals)).toEqual([
      expect.objectContaining({ operation: "workflow.delete", status: "pending" }),
    ]);

    expect(llm.requests.map((request) => request.state)).not.toContain("failed");
    expect(session.issues).toEqual([]);
  });
});
