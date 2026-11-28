// What the chat integration tests share: dsh's own conversation markup (which is not a public
// contract, so it lives in one place; look again when the dsh version moves, docs/DSH.md
// "버전 올리기") and the steps that make a project and talk in its chat.

import type { Locator, Page } from "playwright-core";
import { expect } from "vitest";

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
