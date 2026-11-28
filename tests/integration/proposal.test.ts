// Proposals on a real dsh (stage 2-3a, docs/archive/PLAN_2-3a.md): the fake model calls the tool of an
// operation whose agent call proposes; the proposal shows in the project state as pending and
// nothing else changes; the page accepts it through the view API, which runs the operation as the
// user; and the agent's next turn carries a project update that names the decision. The tool of an
// operation that agents may not call is not offered at all.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import { afterEach, expect, test } from "vitest";
import type { FakeReply, FakeScript } from "../harness/llm.ts";
import {
  MEMO_TOOL,
  afterTool,
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
import { NONE_OPERATION, PROPOSE_OPERATION } from "./fixtures/proposal-component.ts";

afterEach(removeTempFiles);

const COMPONENT_PATH = fileURLToPath(new URL("./fixtures/proposal-component.ts", import.meta.url));

/** The tools of the fixture's operations: `cs_` and the name with `_` for the dot. */
const PROPOSE_TOOL = "cs_probe_card_remove";
const NONE_TOOL = "cs_probe_card_review";

/** The `propose` turn calls the proposing tool; any other turn gets a plain reply. */
const script: FakeScript = (request): FakeReply => {
  if (isTitleRequest(request)) return { text: "Proposal chat" };
  if (turnOf(request) === "propose") {
    return afterTool(request)
      ? { text: "proposal written" }
      : {
          toolCalls: [
            {
              name: PROPOSE_TOOL,
              arguments: { text: "alpha", reason: "the user wants the alpha card gone" },
            },
          ],
        };
  }
  return { text: "plain reply" };
};

/** The lines of the project's record file: records and their updates. */
function recordLines(project: ListedProject): unknown[] {
  const file = join(project.path, ".comfy-studio", "records.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
}

interface WireProposal {
  id: string;
  operation: string;
  status: string;
  intent: string;
  record?: string;
}

interface WireStateBody {
  head: string;
  components: {
    proj: { records: Array<{ id: string }>; proposals: Record<string, WireProposal> };
    probe_card?: { removed: string[] };
  };
}

/** The project state as the page reads it. */
function stateOf(page: Page, project: ListedProject): Promise<WireStateBody> {
  return page.evaluate<WireStateBody>(
    `fetch("/api/cs/state?project=${project.id}").then((response) => response.json())`,
  );
}

test("an agent's call of a proposing tool waits for the user, and the decision reaches the agent", async () => {
  const proposalPatch = patchFile(
    [{ insert: [{ id: "cs-test-proposal", name: COMPONENT_PATH }] }],
    "proposal.patch.yml",
  );
  await withChat(
    script,
    async ({ llm, session, page }) => {
      const project = await createProject(page);
      const chat = visibleChat(page);

      await send(page, "cs-turn:propose remove the alpha card");
      await seeText(chat, "proposal written");
      await waitIdle(page);

      // The model is offered the proposing tool and the other tools, never the tool of an
      // operation that agents may not call.
      const [first, second] = agentRequests(llm, "propose");
      if (first === undefined || second === undefined) throw new Error("The turn made no request.");
      expect(first.tools).toEqual(expect.arrayContaining([PROPOSE_TOOL, MEMO_TOOL]));
      expect(first.tools).not.toContain(NONE_TOOL);
      // The views still get both operations, with what an agent's call of each does.
      const operations = await page.evaluate<Array<{ name: string; agent: string }>>(
        `fetch("/api/cs/operations").then((response) => response.json())`,
      );
      expect(operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: PROPOSE_OPERATION, agent: "propose" }),
          expect.objectContaining({ name: NONE_OPERATION, agent: "none" }),
        ]),
      );
      // The tool result says the call proposed and changed nothing.
      const result = second.messages.at(-1);
      expect(result?.role).toBe("tool");
      expect(result?.text).toMatch(/^proposed \S+: the call of cs_probe_card_remove waits for/);

      // The proposal is pending in the state; nothing else changed.
      const before = await stateOf(page, project);
      const proposals = Object.values(before.components.proj.proposals);
      expect(proposals).toEqual([
        expect.objectContaining({
          operation: PROPOSE_OPERATION,
          status: "pending",
          intent: "the user wants the alpha card gone",
        }),
      ]);
      const [proposal] = proposals;
      if (proposal === undefined) throw new Error("No proposal is listed.");
      expect(before.components.proj.records).toHaveLength(1);
      expect(before.components.probe_card).toEqual({ removed: [] });
      expect(recordLines(project)).not.toContainEqual(
        expect.objectContaining({ operation: PROPOSE_OPERATION }),
      );

      // The page accepts it: the operation runs as the user.
      const decided = await page.evaluate<{ proposal: WireProposal; record: { id: string } }>(
        `fetch("/api/cs/proposal/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: ${JSON.stringify(
            JSON.stringify({
              project: project.id,
              proposal: proposal.id,
              decision: "accept",
              surface: "view",
            }),
          )},
        }).then((response) => response.json())`,
      );
      expect(decided.proposal).toMatchObject({ status: "accepted", record: decided.record.id });
      expect(recordLines(project)).toContainEqual(
        expect.objectContaining({
          id: decided.record.id,
          operation: PROPOSE_OPERATION,
          actor: "user",
          surface: "view",
          params: { text: "alpha" },
        }),
      );
      const after = await stateOf(page, project);
      expect(after.components.probe_card).toEqual({ removed: ["alpha"] });
      expect(after.components.proj.proposals[proposal.id]?.status).toBe("accepted");

      // The next turn tells the agent what the user decided.
      await send(page, "cs-turn:after what changed");
      await seeText(chat, "plain reply");
      await waitIdle(page);
      const [next] = agentRequests(llm, "after");
      const updates = next?.messages.find((message) =>
        message.text.startsWith("Project updates since your last step"),
      );
      expect(updates?.text).toContain(`removed the card alpha`);
      expect(updates?.text).toContain(
        `accepted proposal ${proposal.id} of ${PROPOSE_TOOL}; it ran as record ${decided.record.id}`,
      );

      expect(llm.requests.map((request) => request.state)).not.toContain("failed");
      expect(session.issues).toEqual([]);
    },
    { patches: [proposalPatch] },
  );
});
