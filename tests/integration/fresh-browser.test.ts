// A browser with no saved state lands on our home page, not on a blank chat of the last
// project; opening the project from home shows its latest conversation, and a reload of that
// browser returns to the project it was viewing. Decided 2026-11-28 (docs/archive/PLAN_1-5.md).
//
// dsh keeps the session a browser views in that browser's localStorage, so a second browser
// (a new browser profile) is the case of another device, a private window or another address.

import { afterEach, expect, test } from "vitest";
import { openPage } from "../harness/browser.ts";
import { launchDsh } from "../harness/dsh.ts";
import { startFakeLlm } from "../harness/llm.ts";
import type { FakeReply, FakeScript } from "../harness/llm.ts";
import {
  createProject,
  seeText,
  send,
  STEP_TIMEOUT_MS,
  visibleChat,
  waitIdle,
} from "./chat-rig.ts";

const REPLY = "reply from the first browser";

/**
 * dsh's startup restore runs once its lists have arrived, a moment after our project cards
 * show (the shell used to open the project by 1.5 s, see shell.test.ts). There is no signal
 * of "the restore did not happen", so the check waits this long after the cards are on screen.
 */
const RESTORE_SETTLE_MS = 3_000;

const script: FakeScript = (request): FakeReply =>
  request.tools.length === 0 ? { text: "Fresh chat" } : { text: REPLY };

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

test("a fresh browser lands on home, and the project opens on its latest chat from there", async () => {
  const llm = await startFakeLlm(script);
  closers.push(() => llm.close());
  const dsh = await launchDsh({ patches: [llm.patch] });
  closers.push(() => dsh.stop());

  // Browser 1 makes a project and talks in it.
  const first = await openPage(dsh.url, { modelConfigured: true });
  let firstClosed = false;
  try {
    const project = await createProject(first.page);
    await send(first.page, "hello there");
    await seeText(visibleChat(first.page), REPLY);
    await waitIdle(first.page);
    expect(first.issues).toEqual([]);
    await first.close();
    firstClosed = true;

    // Browser 2 has no saved state at all. dsh keeps the first-run acknowledgement on the
    // server, so browser 1's click already answered it for this one.
    const second = await openPage(dsh.url, { modelConfigured: true, dismissFirstRun: false });
    closers.push(() => second.close());
    const { page } = second;
    const card = page.locator(`[data-cs-home] [data-cs-project-card="${project.id}"]`);
    await card.waitFor({ timeout: STEP_TIMEOUT_MS });
    expect(await page.locator("[data-cs-project-frame]").count()).toBe(0);
    await page.waitForTimeout(RESTORE_SETTLE_MS);
    expect(await page.locator("[data-cs-project-frame]").count()).toBe(0);
    await card.waitFor({ timeout: STEP_TIMEOUT_MS });

    // From home, the project opens on the chat it already had.
    await card.click();
    await page
      .locator(`[data-cs-project-frame="${project.id}"]`)
      .waitFor({ timeout: STEP_TIMEOUT_MS });
    await seeText(visibleChat(page), REPLY, STEP_TIMEOUT_MS);

    // The browser now has its own state: a reload returns to the project, not to home.
    await page.reload({ waitUntil: "networkidle" });
    await page
      .locator(`[data-cs-project-frame="${project.id}"]`)
      .waitFor({ timeout: STEP_TIMEOUT_MS });
    await seeText(visibleChat(page), REPLY, STEP_TIMEOUT_MS);
    expect(second.issues).toEqual([]);
  } finally {
    if (!firstClosed) await first.close();
  }
});
