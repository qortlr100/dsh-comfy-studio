// The shell (@cs/ui-shell) in a real dsh: our brand, navigator and center replace dsh's, a
// project can be made, opened, renamed and taken off the list, and its chat sits in the right
// panel with a composer that takes text. Spec: docs/archive/PLAN_3-0.md "시험".
//
// No model key is configured, so nothing here sends a message (step 1-3).

import { existsSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import { expect, test } from "vitest";
import { openPage } from "../harness/browser.ts";
import { launchDsh } from "../harness/dsh.ts";

const OWNER = "@cs/ui-shell";
const STEP_TIMEOUT_MS = 10_000;
/** dsh's first-use start runs after its lists arrive; its failure toast showed by 1.5 s. */
const FIRST_USE_SETTLE_MS = 1_500;

interface ListedProject {
  id: string;
  title: string;
  path: string;
}

/** The project list as the view API serves it to the logged-in page. */
async function listProjects(page: Page): Promise<ListedProject[]> {
  return page.evaluate<ListedProject[]>(
    `fetch("/api/cs/projects").then((response) => response.json())`,
  );
}

async function attribute(locator: Locator, name: string): Promise<string> {
  const value = await locator.getAttribute(name, { timeout: STEP_TIMEOUT_MS });
  if (value === null) throw new Error(`The element has no ${name} attribute.`);
  return value;
}

/** Makes a project with the sidebar button and waits until the center shows it. */
async function createProject(page: Page, known: readonly string[]): Promise<string> {
  await page.locator("[data-cs-new-project]").click();
  const frame = page.locator("[data-cs-project-frame]");
  await expect
    .poll(
      async () =>
        (await frame.count()) === 1 ? frame.getAttribute("data-cs-project-frame") : null,
      {
        timeout: STEP_TIMEOUT_MS,
      },
    )
    .not.toSatisfy((id: string | null) => id === null || known.includes(id));
  return attribute(frame, "data-cs-project-frame");
}

test("the shell replaces dsh's chrome and a project can be made, opened and renamed", async () => {
  const dsh = await launchDsh();
  try {
    const session = await openPage(dsh.url);
    try {
      const { page } = session;

      // Brand: our name and mark in dsh's brand slots.
      const brand = page.locator('[data-slot="sidebar.brand.name"] [data-cs-brand]');
      await brand.waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
      expect(await brand.textContent()).toBe("ComfyStudio");
      await page
        .locator('[data-slot="sidebar.brand.mark"] [data-cs-brand-mark]')
        .first()
        .waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
      expect(await page.locator(`style[data-plugin="${OWNER}"]`).count()).toBeGreaterThan(0);

      // A fresh home has no project: the center is our home page, not dsh's hero, and the
      // sidebar lists projects, not dsh workspaces.
      await page
        .locator("[data-cs-home] [data-cs-home-empty]")
        .waitFor({ timeout: STEP_TIMEOUT_MS });
      await page
        .locator('[data-slot="sidebar.workspaces"] [data-cs-navigator]')
        .waitFor({ timeout: STEP_TIMEOUT_MS });
      expect(await page.locator('[data-slot="conversation.hero.frame"]').count()).toBe(0);
      expect(await attribute(page.locator("[data-cs-nav-home]"), "aria-current")).toBe("page");
      // dsh's New Session button gave way to ours: the slot that wraps it holds our button
      // and no other.
      const sessionAction = page.locator('[data-slot="sidebar.session.action"]');
      expect(await sessionAction.locator("[data-cs-new-project]").count()).toBe(1);
      expect(await sessionAction.locator("button:not([data-cs-new-project])").count()).toBe(0);
      // chrome.ts: dsh did not try to create its default workspace. Without the device the
      // attempt fails in this home (no documents folder) and toasts within about a second.
      await page.waitForTimeout(FIRST_USE_SETTLE_MS);
      expect(await page.getByText("Unable to create default workspace").count()).toBe(0);
      expect(await listProjects(page)).toEqual([]);

      // Make a project: it opens in the center and is the active row of the navigator.
      const projectId = await createProject(page, []);
      const frame = page.locator(`[data-cs-project-frame="${projectId}"]`);
      await expect
        .poll(() => frame.locator("[data-cs-project-title]").textContent(), {
          timeout: STEP_TIMEOUT_MS,
        })
        .toBe("새 프로젝트");
      const row = page.locator(`[data-cs-navigator] [data-cs-project="${projectId}"]`);
      await expect
        .poll(() => row.getAttribute("data-active"), { timeout: STEP_TIMEOUT_MS })
        .toBe("");
      expect(await page.locator("[data-cs-nav-home]").getAttribute("aria-current")).toBeNull();
      expect(await frame.locator("[data-cs-no-views]").count()).toBe(1);

      const [listed] = await listProjects(page);
      expect(listed).toMatchObject({ id: projectId, title: "새 프로젝트" });
      const folder = listed?.path ?? "";
      expect(existsSync(folder)).toBe(true);
      // The folder is under the temp HOME of this dsh, not under its DSH_HOME.
      expect(folder.startsWith(dsh.home.userHome)).toBe(true);

      // The chat of the project opens as a right-panel tab, and its composer takes text.
      const chat = page.locator("[data-cs-chat]");
      await chat.waitFor({ timeout: STEP_TIMEOUT_MS });
      const editor = chat.locator('[contenteditable="true"]').first();
      await editor.waitFor({ timeout: STEP_TIMEOUT_MS });
      await editor.click();
      await page.keyboard.type("hello shell");
      await expect
        .poll(() => editor.textContent(), { timeout: STEP_TIMEOUT_MS })
        .toContain("hello shell");
      // The project's one chat session is listed under it and is the active one.
      const chatRow = row.locator("[data-cs-session]");
      await expect.poll(() => chatRow.count(), { timeout: STEP_TIMEOUT_MS }).toBe(1);
      expect(await chatRow.getAttribute("data-active")).toBe("");
      // The caret folds and unfolds the chat list, also of the open project.
      const toggle = row.locator("[data-cs-chats-toggle]");
      await toggle.click();
      await expect.poll(() => chatRow.count(), { timeout: STEP_TIMEOUT_MS }).toBe(0);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      await toggle.click();
      await expect.poll(() => chatRow.count(), { timeout: STEP_TIMEOUT_MS }).toBe(1);

      // Rename from the row menu.
      await row.locator("[data-cs-project-menu]").click();
      await page.locator('[data-cs-action="rename"]').waitFor({ timeout: STEP_TIMEOUT_MS });
      // The menu hangs below its row, past the end of a navigator with one project; nothing
      // may clip or cover its last item.
      expect(await isTopmostAtCentre(page, '[data-cs-action="remove"]')).toBe(true);
      await page.locator('[data-cs-action="rename"]').click();
      const rename = row.locator("[data-cs-rename]");
      await rename.fill("Portraits");
      await rename.press("Enter");
      await expect
        .poll(() => frame.locator("[data-cs-project-title]").textContent(), {
          timeout: STEP_TIMEOUT_MS,
        })
        .toBe("Portraits");
      await expect
        .poll(() => row.locator("[data-cs-project-open]").textContent(), {
          timeout: STEP_TIMEOUT_MS,
        })
        .toBe("Portraits");

      // A dsh page (Plugins) takes the center; a project row brings the project back.
      await page.getByRole("button", { name: "Plugins", exact: true }).click();
      await expect
        .poll(() => page.locator("[data-cs-project-frame]").count(), { timeout: STEP_TIMEOUT_MS })
        .toBe(0);
      await row.locator("[data-cs-project-open]").click();
      await frame.waitFor({ timeout: STEP_TIMEOUT_MS });

      // Home lists the project as a card; the card opens it again.
      await page.locator("[data-cs-nav-home]").click();
      const card = page.locator(`[data-cs-home] [data-cs-project-card="${projectId}"]`);
      await card.waitFor({ timeout: STEP_TIMEOUT_MS });
      expect(await page.locator("[data-cs-project-frame]").count()).toBe(0);
      // Home folds the right panel: no chat beside the project list.
      await expect.poll(() => visibleChats(page), { timeout: STEP_TIMEOUT_MS }).toBe(0);
      await card.click();
      await frame.waitFor({ timeout: STEP_TIMEOUT_MS });
      // The main session did not change, and the chat is back all the same.
      await expect.poll(() => visibleChats(page), { timeout: STEP_TIMEOUT_MS }).toBe(1);

      // A second project, then take it off the list: the center goes home, the first project
      // stays, and the removed project's folder is still on disk.
      // (Made from home, with the first project's panel folded: the last step comes back to it.)
      await page.locator("[data-cs-nav-home]").click();
      await expect.poll(() => visibleChats(page), { timeout: STEP_TIMEOUT_MS }).toBe(0);
      const secondId = await createProject(page, [projectId]);
      await expect.poll(() => visibleChats(page), { timeout: STEP_TIMEOUT_MS }).toBe(1);
      const second = (await listProjects(page)).find((project) => project.id === secondId);
      const secondRow = page.locator(`[data-cs-navigator] [data-cs-project="${secondId}"]`);
      await secondRow.locator("[data-cs-project-menu]").click();
      await page.locator('[data-cs-action="remove"]').click();
      await page.locator("[data-cs-confirm-remove]").click();
      await page.locator("[data-cs-home]").waitFor({ timeout: STEP_TIMEOUT_MS });
      await expect.poll(() => secondRow.count(), { timeout: STEP_TIMEOUT_MS }).toBe(0);
      expect((await listProjects(page)).map((project) => project.id)).toEqual([projectId]);
      expect(existsSync(second?.path ?? "")).toBe(true);

      // chrome.ts: the brand is dsh's New Session button; pressing it must not leave home for
      // the chat of the latest project.
      expect(
        await page.evaluate<string>(
          `getComputedStyle(document.querySelector("[data-cs-brand]").closest("button")).pointerEvents`,
        ),
      ).toBe("none");
      const brandBox = await brand.boundingBox();
      if (brandBox === null) throw new Error("The brand has no box.");
      await page.mouse.click(brandBox.x + brandBox.width / 2, brandBox.y + brandBox.height / 2);
      await page.waitForTimeout(500);
      expect(await page.locator("[data-cs-home]").count()).toBe(1);
      expect(await page.locator("[data-cs-project-frame]").count()).toBe(0);

      // A reload comes back to the project of the main session: dsh restores the session and
      // the open project follows it. The frame shows as soon as the card is pressed, the main
      // session moves a moment later; the reload must wait for the session.
      await page.locator(`[data-cs-home] [data-cs-project-card="${projectId}"]`).click();
      await frame.waitFor({ timeout: STEP_TIMEOUT_MS });
      await expect
        .poll(() => row.locator("[data-cs-session][data-active]").count(), {
          timeout: STEP_TIMEOUT_MS,
        })
        .toBe(1);
      // This session's panel was folded by an earlier trip home and the main session came from
      // another project in between: its chat opens again.
      await expect.poll(() => visibleChats(page), { timeout: STEP_TIMEOUT_MS }).toBe(1);
      await page.reload({ waitUntil: "networkidle" });
      await frame.waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
      await page.locator("[data-cs-chat]").waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });

      expect(session.issues).toEqual([]);
    } finally {
      await session.close();
    }
  } finally {
    await dsh.stop();
  }
});

test("the shell draws in the dark theme with dsh's tokens", async () => {
  const dsh = await launchDsh();
  try {
    const session = await openPage(dsh.url, { colorScheme: "dark" });
    try {
      const { page } = session;
      await page.locator("[data-cs-home]").waitFor({ timeout: STEP_TIMEOUT_MS });
      // dsh marks the dark theme on <body>; our colours come from its tokens.
      expect(await page.locator("body").getAttribute("data-ds-dark-theme")).not.toBeNull();
      const projectId = await createProject(page, []);
      await page.locator("[data-cs-chat]").waitFor({ timeout: STEP_TIMEOUT_MS });
      const colors = await page.evaluate<{ text: string; base: string }>(`(() => {
        const title = document.querySelector('[data-cs-project-frame="${projectId}"] [data-cs-project-title]');
        return {
          text: getComputedStyle(title).color,
          base: getComputedStyle(document.body).getPropertyValue("--dsw-alias-label-primary").trim(),
        };
      })()`);
      // The title is drawn in the token's colour, which in the dark theme is a light one.
      expect(colors.base).not.toBe("");
      expect(lightness(colors.text)).toBeGreaterThan(0.6);
      expect(session.issues).toEqual([]);
    } finally {
      await session.close();
    }
  } finally {
    await dsh.stop();
  }
});

test("a failed shell action is shown as a toast and leaves the page where it was", async () => {
  const dsh = await launchDsh();
  try {
    const session = await openPage(dsh.url);
    try {
      const { page } = session;
      await page
        .locator("[data-cs-home] [data-cs-home-empty]")
        .waitFor({ timeout: STEP_TIMEOUT_MS });
      // The view API refuses the creation with its usual error body.
      await page.route("**/api/cs/projects", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "the projects folder is not writable", code: "probe" }),
        });
      });
      await page.locator("[data-cs-new-project]").click();
      const toast = page.getByText("작업을 마치지 못했습니다: the projects folder is not writable");
      await toast.first().waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
      expect(await page.locator("[data-cs-home]").count()).toBe(1);
      expect(await page.locator("[data-cs-project-frame]").count()).toBe(0);
      expect(await listProjects(page)).toEqual([]);

      // The failure is reported on the console, and the browser logs the 409 itself.
      expect(session.issues.length).toBeGreaterThan(0);
      for (const issue of session.issues) {
        expect(issue).toMatch(/cs-shell: action failed|status of 409/);
      }
    } finally {
      await session.close();
    }
  } finally {
    await dsh.stop();
  }
});

/**
 * How many chat bodies are on screen. dsh keeps the tab body of a session it left in the DOM,
 * hidden, so there can be several elements and at most one may show.
 */
async function visibleChats(page: Page): Promise<number> {
  return page.locator("[data-cs-chat]").locator("visible=true").count();
}

/** Whether the element, or something inside it, is what a pointer at its centre would hit. */
async function isTopmostAtCentre(page: Page, selector: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element === null) return false;
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && element.contains(hit);
  })()`);
}

/** The mean of the RGB channels of a computed `rgb()`/`rgba()` colour, 0 to 1. */
function lightness(color: string): number {
  const channels = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(color);
  if (channels === null) throw new Error(`Not an rgb colour: ${color}`);
  return (Number(channels[1]) + Number(channels[2]) + Number(channels[3])) / (3 * 255);
}
