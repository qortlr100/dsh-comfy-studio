// What the chat tests share: dsh with the fake model and our bundle, a page, the project's chat
// as our shell draws it, and the reading of the requests the fake model got. Used by
// chat.test.ts, preset.test.ts and dsh-features.test.ts.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "playwright-core";
import { expect } from "vitest";
import { openPage } from "../harness/browser.ts";
import type { PageSession } from "../harness/browser.ts";
import { launchDsh, tempParent } from "../harness/dsh.ts";
import type { DshInstance, LaunchOptions, TestHome } from "../harness/dsh.ts";
import { startFakeLlm } from "../harness/llm.ts";
import type { FakeLlm, FakeRequest, FakeScript } from "../harness/llm.ts";

const COMPONENT_PATH = fileURLToPath(new URL("./fixtures/memo-component.ts", import.meta.url));

/** The fixture's operation as the agent sees it: `cs_` and the name with `_` for the dot. */
export const MEMO_TOOL = "cs_probe_memo_add";

/** The project layer's own tools, registered outside every agent preset. */
export const PROJECT_TOOLS = [
  "cs_proj_create",
  "cs_proj_rename",
  "cs_proj_state",
  "cs_proj_history_list",
  "cs_proj_undo",
  "cs_proj_redo",
  "cs_proj_stale_accept",
  "cs_proj_wait",
];

export const STEP_TIMEOUT_MS = 10_000;
/** A turn here is a few model round trips of the fake plus dsh's own work between them. */
export const TURN_TIMEOUT_MS = 20_000;

// dsh's own conversation markup, which is not a public contract. Everything the chat tests take
// from it is here; look again when the dsh version moves (docs/DSH.md "버전 올리기").
export const DSH_CHAT = {
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

// dsh's own sidebar markup and session storage, which are not public contracts either; look
// again when the dsh version moves, like DSH_CHAT.
export const DSH_SIDEBAR = {
  /**
   * The wide sidebar's brand: dsh's New Session button, which holds our brand name. A click is
   * blocked by the shell (chrome.ts device 2); focus and Enter still press it.
   */
  brand: '[data-slot="sidebar"] button:has([data-cs-brand])',
};

/**
 * The presets a session's log recorded as `agent-preset/selected`, in order. The log is
 * `$DSH_HOME/sessions/<folder key>/<session id>/session.v4.jsonl.zstd` (seen on 0.2.2-rc.5; the
 * event is in dsh's persistence catalog). Empty while the log is missing or mid-write.
 */
export function selectedPresets(home: TestHome, sessionId: string): string[] {
  const root = join(home.dshHome, "sessions");
  if (!existsSync(root)) return [];
  for (const folder of readdirSync(root)) {
    const log = join(root, folder, sessionId, "session.v4.jsonl.zstd");
    if (!existsSync(log)) continue;
    let text: string;
    try {
      text = zstdDecompressSync(readFileSync(log)).toString("utf8");
    } catch {
      return [];
    }
    return text.split("\n").flatMap((line) => {
      if (!line.includes('"agent-preset/selected"')) return [];
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return [];
      }
      const data: unknown =
        typeof event === "object" && event !== null ? Reflect.get(event, "data") : undefined;
      const preset: unknown =
        typeof data === "object" && data !== null ? Reflect.get(data, "agentPreset") : undefined;
      return typeof preset === "string" ? [preset] : [];
    });
  }
  return [];
}

const dirs: string[] = [];

/** Deletes the patch files and folders made so far. Call it from `afterEach`. */
export function removeTempFiles(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** A temp folder removed by `removeTempFiles`. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tempParent(), `cs-dsh-test-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** A `--patch` file with these items (JSON is YAML), removed by `removeTempFiles`. */
export function patchFile(items: unknown[], name = "test.patch.yml"): string {
  const patch = join(tempDir("patch"), name);
  writeFileSync(patch, JSON.stringify(items));
  return patch;
}

/** A patch that adds the fixture component as one row. */
export function componentPatch(): string {
  return patchFile([{ insert: [{ id: "cs-test-memo", name: COMPONENT_PATH }] }], "memo.patch.yml");
}

/** The prompts of the chat tests start with `cs-turn:<name>`; scripts answer by that name. */
export function turnOf(request: FakeRequest): string | undefined {
  const prompts = request.messages.flatMap((message) => {
    const name = message.role === "user" ? /^cs-turn:(\S+)/.exec(message.text)?.[1] : undefined;
    return name === undefined ? [] : [name];
  });
  return prompts.at(-1);
}

/** True for the request that carries a tool's result back to the model. */
export function afterTool(request: FakeRequest): boolean {
  return request.messages.at(-1)?.role === "tool";
}

/** dsh asks the model for a session title in a request of its own, without tools. */
export function isTitleRequest(request: FakeRequest): boolean {
  return request.tools.length === 0;
}

/** The texts of the request's user messages: the prompts and what dsh and we add to them. */
export function userTexts(request: FakeRequest): string[] {
  return request.messages.filter((message) => message.role === "user").map((m) => m.text);
}

/** The agent's requests (no title requests) of the turn named `turn`. */
export function agentRequests(llm: FakeLlm, turn: string): FakeRequest[] {
  return llm.requests.filter((request) => !isTitleRequest(request) && turnOf(request) === turn);
}

export interface ChatRig {
  dsh: DshInstance;
  llm: FakeLlm;
  session: PageSession;
  page: Page;
}

export interface ChatOptions {
  /** More `--patch` files after the fake model's and the fixture component's. */
  patches?: readonly string[];
  /** The rest of the launch; `patches` here is ignored. */
  launch?: Omit<LaunchOptions, "patches">;
}

/** dsh with the fake model as its default model and the fixture component, and a page. */
export async function withChat(
  script: FakeScript,
  body: (rig: ChatRig) => Promise<void>,
  options: ChatOptions = {},
): Promise<void> {
  const llm = await startFakeLlm(script);
  try {
    const dsh = await launchDsh({
      ...options.launch,
      patches: [llm.patch, componentPatch(), ...(options.patches ?? [])],
    });
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

export interface ListedProject {
  id: string;
  title: string;
  path: string;
}

/** Makes a project with the sidebar button and returns it once its chat can take text. */
export async function createProject(page: Page): Promise<ListedProject> {
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
export function visibleChat(page: Page): Locator {
  return page.locator("[data-cs-chat]:visible");
}

/** The text box of a chat tab. */
export function composer(chat: Locator): Locator {
  return chat.locator('[contenteditable="true"]').first();
}

export async function send(page: Page, prompt: string): Promise<void> {
  await composer(visibleChat(page)).click();
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
}

export async function seeText(
  chat: Locator,
  text: string,
  timeout = TURN_TIMEOUT_MS,
): Promise<void> {
  await chat.getByText(text, { exact: false }).first().waitFor({ timeout });
}

/** Waits until the composer offers to send again: no turn is running. */
export async function waitIdle(page: Page): Promise<void> {
  await expect
    .poll(() => visibleChat(page).locator(DSH_CHAT.primary).getAttribute("aria-label"), {
      timeout: TURN_TIMEOUT_MS,
    })
    .toBe(DSH_CHAT.sendLabel);
}

export interface SessionRow {
  id: string;
  title: string;
  active: boolean;
}

/** The chat rows the navigator lists under the open project. */
export async function sessionRows(page: Page): Promise<SessionRow[]> {
  return page.evaluate<SessionRow[]>(
    `[...document.querySelectorAll("[data-cs-navigator] [data-cs-session]")].map((row) => ({
      id: row.getAttribute("data-cs-session"),
      title: row.textContent,
      active: row.hasAttribute("data-active"),
    }))`,
  );
}
