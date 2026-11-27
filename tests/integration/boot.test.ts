// Browser side: dsh boots with our bundle and draws the @cs/ui-shell build probe.

import { expect, test } from "vitest";
import { openPage } from "../harness/browser.ts";
import { launchDsh } from "../harness/dsh.ts";

const OWNER = "@cs/ui-shell";

test("dsh boots with our bundle and renders the ui-shell probe", async () => {
  // launchDsh rejects when any plugin entry did not activate.
  const dsh = await launchDsh();
  try {
    const session = await openPage(dsh.url);
    try {
      const { page } = session;
      const probe = page.locator(`[data-slot="sidebar.footer.action"] [data-cs-probe="${OWNER}"]`);
      await probe.waitFor({ state: "attached", timeout: 10_000 });
      expect(await probe.getAttribute("data-cs-scheme")).toBe("light");

      // The CSS module's injected style element, tagged with the owning package.
      expect(await page.locator(`style[data-plugin="${OWNER}"]`).count()).toBeGreaterThan(0);

      await probe.getByRole("button").click();
      await expect.poll(() => probe.getAttribute("data-cs-scheme")).toBe("dark");

      expect(session.issues).toEqual([]);
    } finally {
      await session.close();
    }
  } finally {
    await dsh.stop();
  }
});
