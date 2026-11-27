// Opens a dsh page in headless Chromium the way a first-time user would see it.
// Spec: docs/archive/PLAN_1-2.md "`browser.ts` — 화면". Pitfalls: docs/DSH.md "함정".

import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { redactLoginUrls } from "./dsh.ts";

export interface PageSession {
  readonly page: Page;
  /** Console errors and warnings plus uncaught page errors, URLs redacted. */
  readonly issues: readonly string[];
  /** Closes the browser too. Safe to call more than once. */
  close(): Promise<void>;
}

export interface OpenPageOptions {
  /** Default true: closes the two dialogs of a fresh home with their buttons. */
  dismissFirstRun?: boolean;
  /** Default "light". */
  colorScheme?: "light" | "dark";
}

const DIALOG_TIMEOUT_MS = 15_000;

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ executablePath: process.env.CHROME || undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Executable doesn't exist|ENOENT/.test(message)) {
      throw new Error(
        'No Chromium for playwright-core. Run "pnpm exec playwright-core install ' +
          'chromium-headless-shell", or set CHROME to a Chrome or Chromium executable.\n' +
          redactLoginUrls(message),
        { cause: error },
      );
    }
    throw new Error(`Could not launch Chromium: ${redactLoginUrls(message)}`, { cause: error });
  }
}

/** Waits for a dialog to appear and closes it with its button; never removes its DOM. */
async function closeDialog(page: Page, title: string, button: string): Promise<void> {
  const target = page.locator('[role="dialog"]', { hasText: title }).getByRole("button", {
    name: button,
  });
  // The dialog opens after the load settles, so its absence right after `goto` means nothing.
  await target.waitFor({ state: "visible", timeout: DIALOG_TIMEOUT_MS });
  await target.click();
  await target.waitFor({ state: "hidden", timeout: DIALOG_TIMEOUT_MS });
}

export async function openPage(url: string, options: OpenPageOptions = {}): Promise<PageSession> {
  const browser = await launchBrowser();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= browser.close();
    return closing;
  };

  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      colorScheme: options.colorScheme ?? "light",
    });
    const page = await context.newPage();
    const issues: string[] = [];
    page.on("console", (message) => {
      const type = message.type();
      if (type === "error" || type === "warning") {
        issues.push(redactLoginUrls(`console.${type}: ${message.text()}`));
      }
    });
    page.on("pageerror", (error) => {
      issues.push(redactLoginUrls(`pageerror: ${error.stack ?? error.message}`));
    });

    await page.goto(url, { waitUntil: "networkidle" });
    if (options.dismissFirstRun ?? true) {
      await closeDialog(page, "Preview Notice", "Continue");
      await closeDialog(page, "Get started", "Close");
    }
    return { page, issues, close };
  } catch (error) {
    await close();
    // Playwright puts the navigated URL, token included, into its messages, so the original
    // error must not travel along as `cause`: test reporters print causes in full.
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    // oxlint-disable-next-line eslint/preserve-caught-error
    throw new Error(`Could not open the dsh page: ${redactLoginUrls(message)}`);
  }
}
