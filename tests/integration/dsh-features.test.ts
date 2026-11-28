// The dsh features our agent relies on (stage 1-4, docs/PLAN_1-4.md), under our agent preset
// and the bundle as it ships, with the fake model calling the tools: a skill of a skill folder,
// web_fetch, a subagent, a schedule that fires on its own, and an MCP server. One dsh launch and
// one chat carry all of them, turn after turn.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createTestHome } from "../harness/dsh.ts";
import type { FakeReply, FakeRequest, FakeScript } from "../harness/llm.ts";
import {
  PROJECT_TOOLS,
  afterTool,
  createProject,
  isTitleRequest,
  patchFile,
  removeTempFiles,
  seeText,
  send,
  turnOf,
  userTexts,
  visibleChat,
  waitIdle,
  withChat,
} from "./chat-rig.ts";

afterEach(removeTempFiles);

const MCP_SERVER = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
/** dsh names an MCP tool `mcp__<server>__<tool>`. */
const MCP_TOOL = "mcp__csecho__echo";
const SKILL = "cs-test-skill";
const SKILL_BODY = "CS-SKILL-BODY: the steps of the test procedure.";
const PAGE_MARK = "CS-WEB-PAGE";
const CHILD_TASK = "CS-CHILD-TASK";
const CHILD_RESULT = "CS-CHILD-RESULT-42";
const FIRED = "CS-FIRED";
/** How far ahead the one-shot schedule is set. */
const SCHEDULE_LEAD_MS = 4_000;

/** An RFC 5545 rule that fires once, `inMs` from now (UTC, second precision). */
function oneShot(inMs: number): string {
  const at = new Date(Date.now() + inMs);
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `DTSTART:${stamp}\nRRULE:FREQ=DAILY;COUNT=1`;
}

function isChild(request: FakeRequest): boolean {
  const users = userTexts(request);
  return users.some((text) => text.startsWith(CHILD_TASK)) && turnOf(request) === undefined;
}

function hasFired(request: FakeRequest): boolean {
  return userTexts(request).some((text) => text.includes(FIRED));
}

function call(name: string, args: Record<string, unknown>): FakeReply {
  return { toolCalls: [{ name, arguments: args }] };
}

function scriptFor(pageUrl: string): FakeScript {
  return (request) => {
    if (isTitleRequest(request)) return { text: "Features chat" };
    if (isChild(request)) return { text: CHILD_RESULT };
    if (hasFired(request)) return { text: "reply to the scheduled message" };
    const done = afterTool(request);
    switch (turnOf(request)) {
      case "skill":
        return done ? { text: "skill done" } : call("skill", { name: SKILL });
      case "web":
        return done ? { text: "web done" } : call("web_fetch", { url: pageUrl });
      case "mcp":
        return done ? { text: "mcp done" } : call(MCP_TOOL, { text: "hello" });
      case "sub": {
        const started = request.messages.some(
          (message) => message.role === "tool" && message.text.includes("started subagent"),
        );
        if (!started) {
          return call("subagent", { description: "Test child task", prompt: `${CHILD_TASK} go` });
        }
        const back = request.messages.some(
          (message) => message.role !== "assistant" && message.text.includes(CHILD_RESULT),
        );
        return { text: back ? `parent saw ${CHILD_RESULT}` : "parent waits" };
      }
      case "sched":
        return done
          ? { text: "scheduled" }
          : call("schedule_create", {
              title: "Test one-shot",
              prompt: `${FIRED} report back`,
              rrule: oneShot(SCHEDULE_LEAD_MS),
              target: "this_session",
            });
      default:
        return { text: "plain reply" };
    }
  };
}

/** The request that carried the result of the turn's tool call back. */
function toolResult(requests: readonly FakeRequest[], turn: string): string {
  const back = requests.find((request) => turnOf(request) === turn && afterTool(request));
  return back?.messages.at(-1)?.text ?? "";
}

test("skills, web_fetch, MCP, a subagent and a schedule work under our preset", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<html><body><h1>${PAGE_MARK}</h1><p>fetched text</p></body></html>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  if (address === null || typeof address === "string") throw new Error("No port.");
  const pageUrl = `http://127.0.0.1:${address.port}/`;

  // A skill in $DSH_HOME/skills, one of the default roots our preset's skill-filesystem reads.
  const home = createTestHome();
  const skillDir = join(home.dshHome, "skills", SKILL);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${SKILL}\ndescription: Tells the steps of the test procedure.\n---\n\n${SKILL_BODY}\n`,
  );
  const mcp = patchFile([
    {
      id: "mcp-manager",
      config: {
        servers: { csecho: { transport: "stdio", command: process.execPath, args: [MCP_SERVER] } },
      },
    },
  ]);

  try {
    await withChat(
      scriptFor(pageUrl),
      async ({ llm, session, page }) => {
        await createProject(page);
        const chat = visibleChat(page);
        const turn = async (name: string, reply: string, timeout?: number): Promise<void> => {
          await send(page, `cs-turn:${name} go`);
          await seeText(chat, reply, timeout);
          await waitIdle(page);
        };

        // Skill: listed to the model, and the skill tool loads its body.
        await turn("skill", "skill done");
        const first = llm.requests.find((request) => turnOf(request) === "skill");
        const listing =
          first === undefined
            ? undefined
            : userTexts(first).find((text) => text.includes("<available_skills>"));
        expect(listing).toContain(SKILL);
        expect(toolResult(llm.requests, "skill")).toContain(SKILL_BODY);

        // web_fetch: a page of a local server comes back as text.
        await turn("web", "web done");
        expect(toolResult(llm.requests, "web")).toContain(PAGE_MARK);

        // MCP: the server's tool reaches the model, runs, and its instructions are in the prompt.
        await turn("mcp", "mcp done");
        const mcpFirst = llm.requests.find((request) => turnOf(request) === "mcp");
        expect(mcpFirst?.tools).toContain(MCP_TOOL);
        expect(mcpFirst?.messages[0]?.text).toContain("CS-MCP-INSTRUCTIONS");
        expect(toolResult(llm.requests, "mcp")).toContain("ECHO:HELLO");

        // Subagent: the child runs with our project tools and its answer returns to the parent.
        await turn("sub", `parent saw ${CHILD_RESULT}`);
        const child = llm.requests.find(isChild);
        // The child runs under the parent's preset: the same tools, ours among them.
        expect(child?.tools).toEqual(expect.arrayContaining(PROJECT_TOOLS));
        expect([...(child?.tools ?? [])].toSorted()).toEqual(
          [...(mcpFirst?.tools ?? [])].toSorted(),
        );

        // Schedule: a one-shot set by the agent fires into this chat with nobody at the page.
        await turn("sched", "scheduled");
        await expect
          .poll(() => llm.requests.some(hasFired), { timeout: SCHEDULE_LEAD_MS + 15_000 })
          .toBe(true);
        const fired = llm.requests.find(hasFired);
        // The same session: the earlier turns of the chat are in the request.
        expect(fired === undefined ? undefined : turnOf(fired)).toBe("sched");
        await seeText(chat, "reply to the scheduled message");

        expect(llm.requests.map((request) => request.state)).not.toContain("failed");
        expect(session.issues).toEqual([]);
      },
      { patches: [mcp], launch: { home } },
    );
  } finally {
    home.remove();
    site.close();
  }
});
