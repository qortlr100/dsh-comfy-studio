// The generation component (@cs/generation, stage 2-3d, docs/archive/PLAN_2-3d.md) on a real dsh
// with a fake generation provider in the catalog: by default the agent's call of the run tool is
// a proposal; the user accepts it and the answer comes back at once with a pending record, which
// the scheduler runs; its outputs enter the asset library for review. Once the user allows it in
// the project's settings, the agent's next call runs without a proposal.

import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import { afterEach, expect, test } from "vitest";
import type { FakeReply, FakeRequest, FakeScript } from "../harness/llm.ts";
import {
  GEN_RUN_TOOL,
  GEN_TOOLS,
  TURN_TIMEOUT_MS,
  agentRequests,
  createProject,
  isTitleRequest,
  patchFile,
  removeTempFiles,
  seeText,
  send,
  turnOf,
  visibleChat,
  waitIdle,
  withChat,
} from "./chat-rig.ts";
import type { ListedProject } from "./chat-rig.ts";
import { FIRST_TARGET, PROVIDER } from "./fixtures/catalog-provider.ts";

afterEach(removeTempFiles);

const PROVIDER_PATH = fileURLToPath(new URL("./fixtures/catalog-provider.ts", import.meta.url));

/** A small graph in ComfyUI's API format; the fake provider runs anything. */
const GRAPH = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "a red fox" } },
  "2": { class_type: "KSampler", inputs: { seed: 7, steps: 20, positive: ["1", 0] } },
  "3": { class_type: "SaveImage", inputs: { filename_prefix: "fox", images: ["2", 0] } },
};
const GRAPH_BASE64 = Buffer.from(JSON.stringify(GRAPH)).toString("base64");

interface Answer<T> {
  status: number;
  body: T;
}

interface WireRecord {
  id: string;
  operation: string | null;
  status: string;
  actor: string;
  outputs: string[];
  report?: { runs?: Array<{ outputs: string[] }> };
}

interface WireStateBody {
  components: {
    proj: {
      records: WireRecord[];
      proposals: Record<string, { id: string; operation: string; status: string }>;
    };
    asset: { items: Record<string, { origin: string; review: string }> };
    gen: { settings: { agent_run: boolean } };
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

/**
 * Whether the turn has called a tool already. Not `afterTool`: a background run can finish right
 * after the call, and the project layer then tells the agent so in a project update, which is a
 * user message after the tool's result.
 */
function calledTool(request: FakeRequest): boolean {
  const start = request.messages.findLastIndex(
    (message) => message.role === "user" && message.text.startsWith("cs-turn:"),
  );
  return request.messages.slice(start + 1).some((message) => message.role === "tool");
}

/** The project's generation records, as the state lists them. */
async function batches(page: Page, project: ListedProject): Promise<WireRecord[]> {
  const state = await stateOf(page, project);
  return state.components.proj.records.filter((record) => record.operation === "gen.run");
}

test("an agent's generation waits for the user by default, runs in the background, and runs at once when the project allows it", async () => {
  /** The workflow the page made, which the script's tool calls name. */
  let workflow = "";
  const script: FakeScript = (request): FakeReply => {
    if (isTitleRequest(request)) return { text: "Generation chat" };
    const turn = turnOf(request);
    if (turn === "first" || turn === "second") {
      return calledTool(request)
        ? { text: `called the run tool (${turn})` }
        : {
            toolCalls: [
              {
                name: GEN_RUN_TOOL,
                arguments: { workflow, count: 2, label: `foxes ${turn}`, reason: "make foxes" },
              },
            ],
          };
    }
    return { text: "plain reply" };
  };
  const providerPatch = patchFile(
    [{ insert: [{ id: "cs-test-catalog-provider", name: PROVIDER_PATH }] }],
    "provider.patch.yml",
  );

  await withChat(
    script,
    async ({ llm, session, page }) => {
      const project = await createProject(page);
      const chat = visibleChat(page);

      // A workflow to run, made from an uploaded graph file.
      const staged = await postBytes<{ asset: string }>(
        page,
        `/api/cs/asset/stage?project=${project.id}&name=fox.json&mime=${encodeURIComponent("application/json")}`,
        GRAPH_BASE64,
      );
      const created = await postJson<{ id: string }>(page, "/api/cs/operation", {
        project: project.id,
        operation: "workflow.create",
        params: {},
        inputs: [{ role: "file", ref: staged.body.asset }],
        surface: "view",
      });
      expect(created.status).toBe(200);
      workflow = created.body.id;

      // The views are told that an agent's call of the run operation depends on the state.
      const operations = await page.evaluate<Array<{ name: string; agent: string }>>(
        `fetch("/api/cs/operations").then((response) => response.json())`,
      );
      expect(operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "gen.run", agent: "by_state" }),
          expect.objectContaining({ name: "gen.settings", agent: "none" }),
        ]),
      );
      expect((await stateOf(page, project)).components.gen.settings).toEqual({ agent_run: false });

      // By default the agent's call is a proposal: nothing runs.
      await send(page, "cs-turn:first make two foxes");
      await seeText(chat, "called the run tool (first)");
      await waitIdle(page);
      const [offered, afterCall] = agentRequests(llm, "first");
      if (offered === undefined || afterCall === undefined) {
        throw new Error("The turn made no request.");
      }
      expect(offered.tools).toEqual(expect.arrayContaining([...GEN_TOOLS, GEN_RUN_TOOL]));
      expect(offered.tools).not.toContain("cs_gen_settings");
      expect(afterCall.messages.at(-1)?.text).toMatch(
        /^proposed \S+: the call of cs_gen_run waits/,
      );
      const proposed = await stateOf(page, project);
      const [proposal] = Object.values(proposed.components.proj.proposals);
      expect(proposal).toMatchObject({ operation: "gen.run", status: "pending" });
      if (proposal === undefined) throw new Error("No proposal is listed.");
      expect(await batches(page, project)).toEqual([]);

      // The user accepts: the answer comes at once with a pending record, and the run goes on in
      // the background.
      const decided = await postJson<{ proposal: { status: string }; record: WireRecord }>(
        page,
        "/api/cs/proposal/decide",
        { project: project.id, proposal: proposal.id, decision: "accept", surface: "view" },
      );
      expect(decided.status).toBe(200);
      expect(decided.body.proposal.status).toBe("accepted");
      expect(decided.body.record).toMatchObject({ operation: "gen.run", actor: "user" });
      expect(["pending", "running", "done"]).toContain(decided.body.record.status);
      await expect
        .poll(async () => (await batches(page, project)).map((record) => record.status), {
          timeout: TURN_TIMEOUT_MS,
        })
        .toEqual(["done"]);

      // Two runs, each with an output; the outputs wait for review in the asset library.
      const [first] = await batches(page, project);
      if (first === undefined) throw new Error("The batch is not in the state.");
      expect(first.id).toBe(decided.body.record.id);
      expect(first.report?.runs).toHaveLength(2);
      expect(first.outputs).toHaveLength(2);
      const library = (await stateOf(page, project)).components.asset.items;
      for (const output of first.outputs) {
        expect(library[output]).toMatchObject({ origin: "output", review: "pending" });
      }

      // Stopping a record that has finished changes nothing and answers the record.
      const stopped = await postJson<WireRecord>(page, "/api/cs/record/cancel", {
        project: project.id,
        record: first.id,
      });
      expect(stopped).toMatchObject({ status: 200, body: { id: first.id, status: "done" } });

      // The user lets agents run generations in this project; the setting is no history step.
      const allowed = await postJson<WireRecord>(page, "/api/cs/operation", {
        project: project.id,
        operation: "gen.settings",
        params: { agent_run: true },
        surface: "view",
      });
      expect(allowed).toMatchObject({ status: 200, body: { status: "done", actor: "user" } });
      expect((await stateOf(page, project)).components.gen.settings).toEqual({ agent_run: true });

      // Now the agent's call runs: no new proposal, a pending record at once, done a little later.
      await send(page, "cs-turn:second two more foxes");
      await seeText(chat, "called the run tool (second)");
      await waitIdle(page);
      const toolResult = agentRequests(llm, "second")
        .at(-1)
        ?.messages.findLast((message) => message.role === "tool");
      expect(toolResult?.text).toMatch(/pending/);
      expect(toolResult?.text).not.toMatch(/^proposed /);
      expect(Object.values((await stateOf(page, project)).components.proj.proposals)).toHaveLength(
        1,
      );
      await expect
        .poll(async () => (await batches(page, project)).map((record) => record.status), {
          timeout: TURN_TIMEOUT_MS,
        })
        .toEqual(["done", "done"]);
      const second = (await batches(page, project)).find((record) => record.id !== first.id);
      expect(second).toMatchObject({ actor: "agent" });
      expect(second?.outputs).toHaveLength(2);

      expect(llm.requests.map((request) => request.state)).not.toContain("failed");
      expect(session.issues).toEqual([]);
    },
    { patches: [providerPatch] },
  );
  // The place the fixture registers, so a reader of this test knows what ran.
  expect([PROVIDER, FIRST_TARGET]).toEqual(["fake", "one"]);
});
