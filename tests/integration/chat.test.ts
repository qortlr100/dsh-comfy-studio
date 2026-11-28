// The chat of a project against a model: a real dsh with our bundle, a browser, and the fake
// model of the harness in place of a real one. What a turn sends to the model (our tools, the
// project rules, the project state and updates), what the right-panel chat draws (reasoning,
// tool calls, the reply), stopping, a turn that outlives its tab, and several chats of one
// project. Spec: docs/archive/PLAN_1-3.md "`tests/integration/chat.test.ts`".
//
// The same was seen once with a real model (2026-11-28, docs/DSH.md "실제 모델로 확인한 것").
// The shell turn of 1-3 is gone since 1-4: our agent preset has no shell tool, and what the
// agent gets is preset.test.ts's to check.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { FakeReply, FakeScript } from "../harness/llm.ts";
import {
  DSH_CHAT,
  MEMO_TOOL,
  PROJECT_TOOLS,
  STEP_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  afterTool,
  agentRequests,
  createProject,
  isTitleRequest,
  removeTempFiles,
  seeText,
  send,
  sessionRows,
  turnOf,
  visibleChat,
  waitIdle,
  withChat,
} from "./chat-rig.ts";
import type { ListedProject } from "./chat-rig.ts";
import { OPERATION } from "./fixtures/memo-component.ts";

afterEach(removeTempFiles);

/** The lines of the project's record file: records and their updates. */
function recordLines(project: ListedProject): unknown[] {
  const file = join(project.path, ".comfy-studio", "records.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
}

/** The memo turn calls the fixture's tool, any other gets a plain reply. */
const turnScript: FakeScript = (request): FakeReply => {
  if (isTitleRequest(request)) return { text: "Memo chat" };
  if (turnOf(request) === "memo") {
    return afterTool(request)
      ? { text: "memo saved: alpha" }
      : {
          reasoning: "The user wants a memo, so the memo tool is the way.",
          toolCalls: [{ name: MEMO_TOOL, arguments: { text: "alpha", reason: "asked for" } }],
        };
  }
  return { text: "plain reply" };
};

test("a turn gives the agent the project's tools and state, and the chat draws its steps", async () => {
  await withChat(turnScript, async ({ llm, session, page }) => {
    const project = await createProject(page);
    const chat = visibleChat(page);

    await send(page, "cs-turn:memo add a memo");
    await seeText(chat, "memo saved: alpha");
    await waitIdle(page);

    // What the model was sent. The tools registered outside the agent preset reach the
    // preset's agent: the project tools and the tool of the fixture's operation.
    const [first, second] = agentRequests(llm, "memo");
    if (first === undefined || second === undefined) throw new Error("The turn made no request.");
    expect(first.tools).toEqual(expect.arrayContaining([...PROJECT_TOOLS, MEMO_TOOL]));
    // The project rules are a section of the system prompt, and the project's state comes as
    // a message of the turn.
    expect(first.messages[0]).toMatchObject({ role: "system" });
    expect(first.messages[0]?.text).toContain("Project rules:");
    const state = first.messages.find((message) => message.text.startsWith("Project state."));
    expect(state?.role).toBe("user");
    expect(state?.text).toContain(project.id);
    expect(state?.text).toContain(project.title);
    // The reasoning goes back to the model with the call it led to.
    expect(second.messages.at(-1)).toMatchObject({ role: "tool" });
    expect(second.messages.at(-2)).toMatchObject({
      role: "assistant",
      toolCalls: [expect.objectContaining({ name: MEMO_TOOL })],
    });

    // The call is a record of the project, made by the agent in this chat's first turn.
    const lines = recordLines(project);
    expect(lines).toContainEqual(
      expect.objectContaining({
        operation: OPERATION,
        actor: "agent",
        surface: "chat",
        turn: "1",
        session: expect.any(String),
        tool_call: expect.any(String),
        params: { text: "alpha" },
      }),
    );
    expect(lines).toContainEqual(expect.objectContaining({ status: "done", outputs: [] }));

    // The chat drew the turn: the prompt, the reply, and under the fold the reasoning and
    // the tool call.
    await seeText(chat, "cs-turn:memo add a memo", STEP_TIMEOUT_MS);
    const fold = chat.locator(DSH_CHAT.process).first();
    await fold.waitFor({ timeout: STEP_TIMEOUT_MS });
    if ((await fold.getAttribute("data-open")) !== "true") await fold.click();
    await expect
      .poll(() => chat.locator(DSH_CHAT.reasoning).first().textContent(), {
        timeout: STEP_TIMEOUT_MS,
      })
      .toContain("The user wants a memo");
    expect(await chat.locator(DSH_CHAT.toolCall(MEMO_TOOL)).count()).toBe(1);

    // A change made from a view reaches the agent with its next turn.
    const run = await page.evaluate<{ status: string }>(
      `fetch("/api/cs/operation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: ${JSON.stringify(
          JSON.stringify({
            project: project.id,
            operation: OPERATION,
            params: { text: "beta" },
            surface: "view",
          }),
        )},
      }).then((response) => response.json())`,
    );
    expect(run.status).toBe("done");
    await send(page, "cs-turn:plain what changed");
    await seeText(chat, "plain reply");
    await waitIdle(page);
    const [plain] = agentRequests(llm, "plain");
    const updates = plain?.messages.find((message) =>
      message.text.startsWith("Project updates since your last step"),
    );
    expect(updates?.text).toContain("added the memo beta");

    expect(llm.requests.map((request) => request.state)).not.toContain("failed");
    expect(session.issues).toEqual([]);
  });
});

/** The `slow` turn streams for about ten seconds unless it is stopped. */
const stopScript: FakeScript = (request): FakeReply => {
  if (isTitleRequest(request)) return { text: "Stop chat" };
  if (turnOf(request) === "slow") {
    return { text: "slow-word ".repeat(400), chunkDelayMs: 25 };
  }
  return { text: "reply after the stop" };
};

test("stop ends the turn and the request to the model, and the chat takes the next turn", async () => {
  await withChat(stopScript, async ({ llm, session, page }) => {
    await createProject(page);
    const chat = visibleChat(page);
    const primary = chat.locator(DSH_CHAT.primary);

    await send(page, "cs-turn:slow write a lot");
    await seeText(chat, "slow-word slow-word");
    expect(await primary.getAttribute("aria-label")).toBe(DSH_CHAT.stopLabel);
    await primary.click();

    await waitIdle(page);
    // dsh hung up on the model instead of letting the reply run out, and did not ask again.
    await expect
      .poll(() => agentRequests(llm, "slow").map((request) => request.state), {
        timeout: STEP_TIMEOUT_MS,
      })
      .toEqual(["aborted"]);

    await send(page, "cs-turn:next go on");
    await seeText(chat, "reply after the stop");
    await waitIdle(page);
    expect(agentRequests(llm, "slow")).toHaveLength(1);
    expect(session.issues).toEqual([]);
  });
});

/** Slow enough for the tab to close before the first reply and to reopen before the last. */
const awayScript: FakeScript = (request): FakeReply => {
  if (isTitleRequest(request)) return { text: "Away chat" };
  return afterTool(request)
    ? { text: "reply written while away", delayMs: 2_500 }
    : {
        delayMs: 1_500,
        toolCalls: [{ name: MEMO_TOOL, arguments: { text: "while away", reason: "asked for" } }],
      };
};

test("a turn goes on without its tab, and a new tab of the browser shows the same chat", async () => {
  await withChat(awayScript, async ({ llm, session, page }) => {
    const project = await createProject(page);
    const [row] = await sessionRows(page);

    await send(page, "cs-turn:away add a memo");
    await expect
      .poll(() => agentRequests(llm, "away").length, { timeout: STEP_TIMEOUT_MS })
      .toBe(1);
    await page.close();

    // No tab is open: the model's call still runs and its result goes back to the model.
    await expect
      .poll(() => agentRequests(llm, "away").length, { timeout: TURN_TIMEOUT_MS })
      .toBe(2);
    expect(recordLines(project)).toContainEqual(
      expect.objectContaining({ operation: OPERATION, params: { text: "while away" } }),
    );

    // Back in the same browser: the same chat, not a fresh one, with the turn's reply.
    const tab = await session.openTab();
    await seeText(visibleChat(tab), "reply written while away");
    await waitIdle(tab);
    const rows = await sessionRows(tab);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: row?.id, active: true });
    expect(agentRequests(llm, "away").map((request) => request.state)).toEqual(["done", "done"]);
    expect(session.issues).toEqual([]);
  });
});

/** Two chats, told apart by their prompts; the title request quotes the prompt it names. */
const chatsScript: FakeScript = (request): FakeReply => {
  if (isTitleRequest(request)) {
    const asked = request.messages.at(-1)?.text ?? "";
    return { text: asked.includes("cs-turn:one") ? "Chat one" : "Chat two" };
  }
  return { text: turnOf(request) === "one" ? "reply of chat one" : "reply of chat two" };
};

test("a project keeps several chats with their conversations, and the navigator switches", async () => {
  await withChat(chatsScript, async ({ session, page }) => {
    await createProject(page);

    await send(page, "cs-turn:one hello");
    await seeText(visibleChat(page), "reply of chat one");
    // The row takes the title the model gave the chat.
    await expect
      .poll(async () => (await sessionRows(page)).map((row) => row.title), {
        timeout: STEP_TIMEOUT_MS,
      })
      .toEqual(["Chat one"]);
    const [one] = await sessionRows(page);
    if (one === undefined) throw new Error("The first chat is not listed.");

    // A second chat of the same project, with a conversation of its own.
    await page.locator("[data-cs-navigator] [data-cs-new-chat]").first().click();
    await expect
      .poll(async () => (await sessionRows(page)).find((row) => row.active)?.id, {
        timeout: STEP_TIMEOUT_MS,
      })
      .not.toBe(one.id);
    await send(page, "cs-turn:two hello");
    await seeText(visibleChat(page), "reply of chat two");
    await expect
      .poll(
        async () =>
          (await sessionRows(page)).map((row) => row.title).toSorted((a, b) => a.localeCompare(b)),
        { timeout: STEP_TIMEOUT_MS },
      )
      .toEqual(["Chat one", "Chat two"]);
    expect(await visibleChat(page).getByText("reply of chat one").count()).toBe(0);

    // Back to the first: the chat on screen is its conversation.
    await page.locator(`[data-cs-navigator] [data-cs-session="${one.id}"]`).click();
    await seeText(visibleChat(page), "reply of chat one", STEP_TIMEOUT_MS);
    expect(await visibleChat(page).getByText("reply of chat two").count()).toBe(0);
    expect((await sessionRows(page)).find((row) => row.active)?.id).toBe(one.id);

    // A reload comes back to the chat that was open.
    await page.reload({ waitUntil: "networkidle" });
    await seeText(visibleChat(page), "reply of chat one", STEP_TIMEOUT_MS);
    expect((await sessionRows(page)).find((row) => row.active)?.id).toBe(one.id);
    expect(session.issues).toEqual([]);
  });
});
