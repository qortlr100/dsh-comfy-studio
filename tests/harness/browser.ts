// Opens a dsh page in headless Chromium the way a first-time user would see it.
// Spec: docs/archive/PLAN_1-2.md "`browser.ts` — 화면". Pitfalls: docs/DSH.md "함정".

import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { redactLoginUrls } from "./dsh.ts";

export interface PageSession {
  readonly page: Page;
  /** Console errors and warnings plus uncaught page errors of every tab, URLs redacted. */
  readonly issues: readonly string[];
  /**
   * Opens the app in another tab of the same browser profile: the login cookie and what the
   * app stored in the browser carry over, as when a user closes the tab and comes back.
   */
  openTab(): Promise<Page>;
  /** Closes the browser too. Safe to call more than once. */
  close(): Promise<void>;
}

export interface OpenPageOptions {
  /** Default true: closes the dialogs of a fresh home with their buttons. */
  dismissFirstRun?: boolean;
  /**
   * Default false. A home with a usable model (the fake one of `llm.ts`) shows no
   * "Get started" dialog, so only the preview notice is closed.
   */
  modelConfigured?: boolean;
  /** Default "light". */
  colorScheme?: "light" | "dark";
  /**
   * Host names the browser resolves to 127.0.0.1, e.g. `["studio.example.test"]`, so a page can
   * be opened through a test proxy under a host name of its own (Chromium `--host-resolver-rules`).
   */
  mapHostsToLoopback?: readonly string[];
}

const DIALOG_TIMEOUT_MS = 15_000;

async function launchBrowser(mapHosts: readonly string[]): Promise<Browser> {
  // One flag only: Chromium keeps the last of a repeated switch.
  const args =
    mapHosts.length === 0
      ? []
      : [`--host-resolver-rules=${mapHosts.map((host) => `MAP ${host} 127.0.0.1`).join(",")}`];
  try {
    return await chromium.launch({ executablePath: process.env.CHROME || undefined, args });
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
  const browser = await launchBrowser(options.mapHostsToLoopback ?? []);
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
    const issues: string[] = [];
    const watch = (tab: Page): Page => {
      tab.on("console", (message) => {
        const type = message.type();
        if (type === "error" || type === "warning") {
          issues.push(redactLoginUrls(`console.${type}: ${message.text()}`));
        }
      });
      tab.on("pageerror", (error) => {
        issues.push(redactLoginUrls(`pageerror: ${error.stack ?? error.message}`));
      });
      return tab;
    };

    const page = watch(await context.newPage());
    await page.goto(url, { waitUntil: "networkidle" });
    if (options.dismissFirstRun ?? true) {
      await closeDialog(page, "Preview Notice", "Continue");
      if (!(options.modelConfigured ?? false)) await closeDialog(page, "Get started", "Close");
    }

    // The origin alone: the cookie of the first visit logs the new tab in, no token needed.
    const origin = new URL(url).origin;
    const openTab = async (): Promise<Page> => {
      try {
        const tab = watch(await context.newPage());
        await tab.goto(origin, { waitUntil: "networkidle" });
        return tab;
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        // oxlint-disable-next-line eslint/preserve-caught-error
        throw new Error(`Could not open another tab: ${redactLoginUrls(message)}`);
      }
    };
    return { page, issues, openTab, close };
  } catch (error) {
    await close();
    // Playwright puts the navigated URL, token included, into its messages, so the original
    // error must not travel along as `cause`: test reporters print causes in full.
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    // oxlint-disable-next-line eslint/preserve-caught-error
    throw new Error(`Could not open the dsh page: ${redactLoginUrls(message)}`);
  }
}
