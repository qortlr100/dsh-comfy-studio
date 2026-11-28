// The chat of a project against a model: a real dsh with our bundle, a browser, and the fake
// model of the harness in place of a real one. What a turn sends to the model (our tools, the
// project rules, the project state and updates), what the right-panel chat draws (reasoning,
// tool calls, the reply), stopping, a turn that outlives its tab, and several chats of one
// project. Spec: docs/archive/PLAN_1-3.md "`tests/integration/chat.test.ts`".
//
// The same was seen once with a real model (2026-11-28, docs/DSH.md "실제 모델로 확인한 것").

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "playwright-core";
import { afterEach, expect, test } from "vitest";
import { openPage } from "../harness/browser.ts";
import type { PageSession } from "../harness/browser.ts";
import { launchDsh, tempParent } from "../harness/dsh.ts";
import type { DshInstance } from "../harness/dsh.ts";
import { startFakeLlm } from "../harness/llm.ts";
import type { FakeLlm, FakeReply, FakeRequest, FakeScript } from "../harness/llm.ts";
import { OPERATION } from "./fixtures/memo-component.ts";

const COMPONENT_PATH = fileURLToPath(new URL("./fixtures/memo-component.ts", import.meta.url));
/** The fixture's operation as the agent sees it: `cs_` and the name with `_` for the dot. */
const MEMO_TOOL = "cs_probe_memo_add";
const PROJECT_TOOLS = [
  "cs_proj_create",
  "cs_proj_rename",
  "cs_proj_state",
  "cs_proj_history_list",
  "cs_proj_undo",
  "cs_proj_redo",
  "cs_proj_stale_accept",
  "cs_proj_wait",
];

const STEP_TIMEOUT_MS = 10_000;
/** A turn here is a few model round trips of the fake plus dsh's own work between them. */
const TURN_TIMEOUT_MS = 20_000;

// dsh's own conversation markup, which is not a public contract. Everything this file takes
// from it is here; look again when the dsh version moves (docs/DSH.md "버전 올리기").
const DSH_CHAT = {
  /** The composer's main button; its label says whether it sends or stops. English locale. */
  primary: '[data-slot="conversation.composer"] button[class*="_primary"]',
  sendLabel: "Send message",
  stopLabel: "Stop generating",
  /** The fold that holds a finished turn's steps; `data-open="true"` when unfolded. */
  process: "button[data-turn-process]",
  reasoning: '[data-variant="think"]',
  /** The tool call's view slot (public) and the tool name dsh puts on its root. */
  toolCall: (tool: string) => `[data-slot="tool.call.toolview"] [data-tool="${tool}"]`,
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A patch that adds the fixture component as one row. */
function componentPatch(): string {
  const dir = mkdtempSync(join(tempParent(), "cs-dsh-test-patch-"));
  dirs.push(dir);
  const patch = join(dir, "memo.patch.yml");
  writeFileSync(
    patch,
    JSON.stringify([{ insert: [{ id: "cs-test-memo", name: COMPONENT_PATH }] }]),
  );
  return patch;
}

/** The prompts of this file start with `cs-turn:<name>`; the script answers by that name. */
function turnOf(request: FakeRequest): string | undefined {
  const prompts = request.messages.flatMap((message) => {
    const name = message.role === "user" ? /^cs-turn:(\S+)/.exec(message.text)?.[1] : undefined;
    return name === undefined ? [] : [name];
  });
  return prompts.at(-1);
}

/** True for the request that carries a tool's result back to the model. */
function afterTool(request: FakeRequest): boolean {
  return request.messages.at(-1)?.role === "tool";
}

/** dsh asks the model for a session title in a request of its own, without tools. */
function isTitleRequest(request: FakeRequest): boolean {
  return request.tools.length === 0;
}

function agentRequests(llm: FakeLlm, turn: string): FakeRequest[] {
  return llm.requests.filter((request) => !isTitleRequest(request) && turnOf(request) === turn);
}

interface Rig {
  dsh: DshInstance;
  llm: FakeLlm;
  session: PageSession;
  page: Page;
}

/** dsh with the fake model as its default model and the fixture component, and a page. */
async function withChat(script: FakeScript, body: (rig: Rig) => Promise<void>): Promise<void> {
  const llm = await startFakeLlm(script);
  try {
    const dsh = await launchDsh({ patches: [llm.patch, componentPatch()] });
    try {
      const session = await openPage(dsh.url, { modelConfigured: true });
      try {
        await body({ dsh, llm, session, page: session.page });
      } finally {
        await session.close();
      }
    } finally {
      await dsh.stop();
    }
  } finally {
    await llm.close();
  }
}

interface ListedProject {
  id: string;
  title: string;
  path: string;
}

/** Makes a project with the sidebar button and returns it once its chat can take text. */
async function createProject(page: Page): Promise<ListedProject> {
  await page.locator("[data-cs-new-project]").click();
  await composer(visibleChat(page)).waitFor({ timeout: STEP_TIMEOUT_MS });
  const projects = await page.evaluate<ListedProject[]>(
    `fetch("/api/cs/projects").then((response) => response.json())`,
  );
  const [project] = projects;
  if (projects.length !== 1 || project === undefined) {
    throw new Error(`Expected one project, got ${projects.length}.`);
  }
  return project;
}

/** The chat tab on screen. A chat that was switched away from can linger in the DOM, hidden. */
function visibleChat(page: Page): Locator {
  return page.locator("[data-cs-chat]:visible");
}

function composer(chat: Locator): Locator {
  return chat.locator('[contenteditable="true"]').first();
}

async function send(page: Page, prompt: string): Promise<void> {
  await composer(visibleChat(page)).click();
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
}

async function seeText(chat: Locator, text: string, timeout = TURN_TIMEOUT_MS): Promise<void> {
  await chat.getByText(text, { exact: false }).first().waitFor({ timeout });
}

/** Waits until the composer offers to send again: no turn is running. */
async function waitIdle(page: Page): Promise<void> {
  await expect
    .poll(() => visibleChat(page).locator(DSH_CHAT.primary).getAttribute("aria-label"), {
      timeout: TURN_TIMEOUT_MS,
    })
    .toBe(DSH_CHAT.sendLabel);
}

/** The lines of the project's record file: records and their updates. */
function recordLines(project: ListedProject): unknown[] {
  const file = join(project.path, ".comfy-studio", "records.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
}

interface SessionRow {
  id: string;
  title: string;
  active: boolean;
}

/** The chat rows the navigator lists under the open project. */
async function sessionRows(page: Page): Promise<SessionRow[]> {
  return page.evaluate<SessionRow[]>(
    `[...document.querySelectorAll("[data-cs-navigator] [data-cs-session]")].map((row) => ({
      id: row.getAttribute("data-cs-session"),
      title: row.textContent,
      active: row.hasAttribute("data-active"),
    }))`,
  );
}

/** The memo turn calls the fixture's tool, the shell turn calls bash, any other gets a plain reply. */
const turnScript: FakeScript = (request): FakeReply => {
  if (isTitleRequest(request)) return { text: "Memo chat" };
  const last = request.messages.at(-1)?.text.trim() ?? "";
  switch (turnOf(request)) {
    case "memo":
      return afterTool(request)
        ? { text: "memo saved: alpha" }
        : {
            reasoning: "The user wants a memo, so the memo tool is the way.",
            toolCalls: [{ name: MEMO_TOOL, arguments: { text: "alpha", reason: "asked for" } }],
          };
    case "shell":
      return afterTool(request)
        ? { text: `shell printed: ${last}` }
        : {
            toolCalls: [
              {
                name: "bash",
                arguments: { command: "echo cs-shell-$((6*7))", description: "print a marker" },
              },
            ],
          };
    default:
      return { text: "plain reply" };
  }
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

    // The standard preset's shell tool runs although pnpm skipped node-pty's install script.
    await send(page, "cs-turn:shell run the shell");
    await seeText(chat, "shell printed: cs-shell-42");
    await waitIdle(page);
    expect(agentRequests(llm, "shell").at(-1)?.messages.at(-1)).toMatchObject({
      role: "tool",
      text: expect.stringContaining("cs-shell-42"),
    });

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
