// Our agent preset (stage 1-4, decided by the user on 2026-11-28; docs/PLAN_1-4.md): what the
// agent of a session made from our shell gets with the bundle as it ships. Exactly our tools and
// the dsh tools of the decision, and no shell or file tool, so the agent can change a project
// only through the project layer's operations. The same holds when the user's default in dsh's
// settings is another preset, because the shell names ours on every session it creates.

import { afterEach, expect, test } from "vitest";
import { runHostScenario } from "../harness/host.ts";
import { FAKE_MODEL } from "../harness/llm.ts";
import type { FakeLlm, FakeReply, FakeRequest, FakeScript } from "../harness/llm.ts";
import {
  MEMO_TOOL,
  PROJECT_TOOLS,
  STEP_TIMEOUT_MS,
  agentRequests,
  createProject,
  isTitleRequest,
  patchFile,
  removeTempFiles,
  seeText,
  send,
  sessionRows,
  turnOf,
  visibleChat,
  waitIdle,
  withChat,
} from "./chat-rig.ts";
import type { AgentPresetsResult } from "./scenarios/agent-presets.ts";

afterEach(removeTempFiles);

/** The preset id of packages/bundle/cordis.patch.yml and the shell's ids.ts. */
const PRESET = "comfy-studio";

/** What dsh gives our agent: the decision's list, nothing more. */
const DSH_TOOLS = [
  "ask_user_question",
  "list_agents",
  "schedule_create",
  "schedule_edit",
  "schedule_list",
  "schedule_view",
  "send_message",
  "skill",
  "subagent",
  "todo_write",
  "wait_agent",
  "web_fetch",
];

const EXPECTED_TOOLS = [...PROJECT_TOOLS, MEMO_TOOL, ...DSH_TOOLS].toSorted();

/** The persona of our preset as the model reads it, with `{{model}}` filled in. */
const PERSONA =
  "You are the assistant of ComfyStudio, a studio for making images and video with ComfyUI, " +
  `powered by the ${FAKE_MODEL} model. You work in one project and change it only through ` +
  "the project's tools.";

const script: FakeScript = (request): FakeReply =>
  isTitleRequest(request) ? { text: "Preset chat" } : { text: `reply ${turnOf(request) ?? "?"}` };

const presets = new URL("./scenarios/agent-presets.ts", import.meta.url);

function firstOf(llm: FakeLlm, turn: string): FakeRequest {
  const [first] = agentRequests(llm, turn);
  if (first === undefined) throw new Error(`The turn ${turn} made no request.`);
  return first;
}

test("a chat made from the shell gets our preset: our tools, the decided dsh tools, our persona", async () => {
  await withChat(script, async ({ llm, session, page }) => {
    const project = await createProject(page);
    await send(page, "cs-turn:probe hello");
    await seeText(visibleChat(page), "reply probe");
    await waitIdle(page);

    const first = firstOf(llm, "probe");
    // Exactly: a shell, file or workflow tool (bash, write, edit, read, glob, grep, workflow,
    // subagent_fork, working_directory) or any other new one fails here.
    expect([...first.tools].toSorted()).toEqual(EXPECTED_TOOLS);

    // Our persona in place of dsh's coding agent, with the project rules still after it.
    const system = first.messages[0];
    expect(system?.role).toBe("system");
    const text = system?.text ?? "";
    expect(text).toContain(PERSONA);
    expect(text).not.toContain("You are a coding agent");
    expect(text).toContain("Project rules:");
    expect(text.indexOf(PERSONA)).toBeLessThan(text.indexOf("Project rules:"));
    // The working folder and the time still come with the turn.
    expect(first.messages.some((message) => message.text.includes(project.path))).toBe(true);
    expect(first.messages.some((message) => message.text.startsWith("Time sampled"))).toBe(true);

    // The project's state still comes with the first turn.
    const state = first.messages.find((message) => message.text.startsWith("Project state."));
    expect(state?.role).toBe("user");
    expect(state?.text).toContain(project.id);
    expect(session.issues).toEqual([]);
  });

  // The roster: ours is the default and activated, and dsh's own presets are still there.
  const roster = await runHostScenario<AgentPresetsResult>(presets);
  expect(roster.defaultId).toBe(PRESET);
  expect(roster.presets.map((preset) => preset.id)).toEqual(
    expect.arrayContaining([PRESET, "standard", "ptc", "minimal", "cordis"]),
  );
  expect(roster.presets.filter((preset) => preset.broken !== undefined)).toEqual([]);
});

test("with the user's default switched to standard, chats made from the shell keep our preset", async () => {
  // What dsh's settings page writes when the user makes standard the default.
  const userDefault = patchFile([
    { id: "agent-preset-registry", config: { default: PRESET, selectedDefault: "standard" } },
  ]);

  // The patch does switch dsh's default: a session made without a named preset would be standard.
  const roster = await runHostScenario<AgentPresetsResult>(presets, { patches: [userDefault] });
  expect(roster.defaultId).toBe("standard");

  await withChat(
    script,
    async ({ llm, session, page }) => {
      await createProject(page);
      await send(page, "cs-turn:first hello");
      await seeText(visibleChat(page), "reply first");
      await waitIdle(page);
      expect([...firstOf(llm, "first").tools].toSorted()).toEqual(EXPECTED_TOOLS);

      // A second chat of the project, from the navigator's new-chat button.
      const [one] = await sessionRows(page);
      await page.locator("[data-cs-navigator] [data-cs-new-chat]").first().click();
      await expect
        .poll(async () => (await sessionRows(page)).find((row) => row.active)?.id, {
          timeout: STEP_TIMEOUT_MS,
        })
        .not.toBe(one?.id);
      await send(page, "cs-turn:second hello");
      await seeText(visibleChat(page), "reply second");
      await waitIdle(page);
      expect([...firstOf(llm, "second").tools].toSorted()).toEqual(EXPECTED_TOOLS);
      expect(session.issues).toEqual([]);
    },
    { patches: [userDefault] },
  );
});
