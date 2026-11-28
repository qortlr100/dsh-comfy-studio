// dsh behind a reverse proxy on a host name of its own, the way a deployment runs it: the
// proxy keeps the browser's Host, dsh trusts that host name (`--trusted-host`), and the app
// works as on loopback (login, project, chat, live event stream, WebSocket). Also what dsh
// answers without that flag, with a proxy that rewrites Host, and across a restart on the same
// home. Findings and the proxies tried by hand (nginx, Caddy, TLS): docs/archive/PLAN_1-5.md.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { openPage } from "../harness/browser.ts";
import { createTestHome, launchDsh, tempParent, tokenOf } from "../harness/dsh.ts";
import { freePort, rawRequest } from "../harness/http.ts";
import { startFakeLlm } from "../harness/llm.ts";
import { startProxy } from "../harness/proxy.ts";
import { OPERATION } from "./fixtures/memo-component.ts";

const COMPONENT_PATH = fileURLToPath(new URL("./fixtures/memo-component.ts", import.meta.url));
const FAKE_HOST = "studio.example.test";
const LOOPBACK = "127.0.0.1";
const STEP_TIMEOUT_MS = 10_000;
/** What "live" means for an event on the stream: well under the time a buffering hop would take. */
const LIVE_EVENT_MS = 2_000;

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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The `name=value` pair of the cookie a response sets; the test fails when it sets none. */
function cookieOf(headers: { "set-cookie"?: string[] }): string {
  const cookie = headers["set-cookie"]?.[0]?.split(";")[0];
  if (cookie === undefined || cookie === "") throw new Error("The answer sets no cookie.");
  return cookie;
}

/** What the page script reports: how long the stream took to say ready and to show the change. */
interface StreamReport {
  readyMs: number;
  lineMs: number;
}

// Runs in the page. It opens the event stream, lets it idle (a buffering hop would hold back
// what comes next), runs an operation and times the event that reports it.
function streamScript(project: string): string {
  return `(async () => {
    const kinds = [];
    const source = new EventSource("/cs/events?project=${project}");
    for (const kind of ["ready", "record", "update", "line"]) {
      source.addEventListener(kind, () => kinds.push(kind));
    }
    const until = (kind, from) => new Promise((resolve, reject) => {
      const tick = () => {
        if (kinds.includes(kind)) resolve(performance.now() - from);
        else if (performance.now() - from > 8000) reject(new Error("no " + kind + " event: " + kinds));
        else setTimeout(tick, 10);
      };
      tick();
    });
    try {
      const readyMs = await until("ready", performance.now());
      await new Promise((resolve) => setTimeout(resolve, 500));
      const started = performance.now();
      await fetch("/api/cs/operation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "${project}",
          operation: ${JSON.stringify(OPERATION)},
          params: { text: "through the proxy" },
          surface: "view",
        }),
      });
      const lineMs = await until("line", started);
      return { readyMs, lineMs };
    } finally {
      source.close();
    }
  })()`;
}

test("behind a proxy on its own host name the app works: login, project, chat, live events", async () => {
  const llm = await startFakeLlm((request) =>
    request.tools.length === 0 ? { text: "Proxy chat" } : { text: "reply through the proxy" },
  );
  try {
    const upstreamPort = await freePort();
    const publicPort = await freePort();
    const dsh = await launchDsh({
      patches: [llm.patch, componentPatch()],
      port: upstreamPort,
      trustedHost: FAKE_HOST,
      publicUrl: `http://${FAKE_HOST}:${publicPort}/`,
    });
    try {
      const proxy = await startProxy({
        upstream: { host: LOOPBACK, port: upstreamPort },
        port: publicPort,
      });
      try {
        // dsh prints the login URL with the public origin, which only the proxy answers.
        expect(new URL(dsh.url).host).toBe(`${FAKE_HOST}:${publicPort}`);
        const session = await openPage(dsh.url, {
          modelConfigured: true,
          mapHostsToLoopback: [FAKE_HOST],
        });
        try {
          const { page } = session;
          await page.locator("[data-cs-new-project]").click();
          const chat = page.locator("[data-cs-chat]:visible");
          const composer = chat.locator('[contenteditable="true"]').first();
          await composer.waitFor({ timeout: STEP_TIMEOUT_MS });

          await composer.click();
          await page.keyboard.type("hello through the proxy");
          await page.keyboard.press("Enter");
          await chat
            .getByText("reply through the proxy", { exact: false })
            .first()
            .waitFor({ timeout: 20_000 });

          const projects = await page.evaluate<{ id: string }[]>(
            `fetch("/api/cs/projects").then((response) => response.json())`,
          );
          const [project] = projects;
          if (project === undefined) throw new Error("The project is not listed.");
          const report = await page.evaluate<StreamReport>(streamScript(project.id));
          expect(report.lineMs).toBeLessThan(LIVE_EVENT_MS);

          // dsh's own connection to the server goes through the proxy as a WebSocket.
          expect(proxy.upgrades).toBeGreaterThan(0);
          expect(proxy.seen.every((entry) => entry.host === `${FAKE_HOST}:${publicPort}`)).toBe(
            true,
          );
          expect(session.issues).toEqual([]);
        } finally {
          await session.close();
        }
      } finally {
        await proxy.close();
      }
    } finally {
      await dsh.stop();
    }
  } finally {
    await llm.close();
  }
}, 60_000);

test("dsh refuses a proxied host name it was not told about, and a rewritten Host with an Origin", async () => {
  const plainPort = await freePort();
  const trustedPort = await freePort();
  const [plain, trusted] = await Promise.all([
    launchDsh({ port: plainPort }),
    launchDsh({ port: trustedPort, trustedHost: FAKE_HOST }),
  ]);
  try {
    const plainProxy = await startProxy({ upstream: { host: LOOPBACK, port: plainPort } });
    const trustedProxy = await startProxy({ upstream: { host: LOOPBACK, port: trustedPort } });
    const rewriting = await startProxy({
      upstream: { host: LOOPBACK, port: trustedPort },
      preserveHost: false,
    });
    try {
      const through = (port: number): { host: string; port: number } => ({ host: LOOPBACK, port });
      const authority = (port: number): string => `${FAKE_HOST}:${port}`;

      // Without --trusted-host the fence answers before any login is asked for.
      const untrusted = await rawRequest(through(plainProxy.port), "/api/cs/projects", {
        host: authority(plainProxy.port),
      });
      expect(untrusted.status).toBe(403);

      // With it the same request gets as far as the login check.
      const unauthenticated = await rawRequest(through(trustedProxy.port), "/api/cs/projects", {
        host: authority(trustedProxy.port),
      });
      expect(unauthenticated.status).toBe(401);

      // A proxy that sends dsh its own authority as Host: dsh sees loopback, but the browser's
      // Origin names another host, which is refused. Without the Origin the request passes.
      const login = await rawRequest(through(trustedPort), `/?token=${tokenOf(trusted.url)}`);
      const cookie = cookieOf(login.headers);
      const withoutOrigin = await rawRequest(through(rewriting.port), "/api/cs/projects", {
        host: authority(rewriting.port),
        headers: { cookie },
      });
      expect(withoutOrigin.status).toBe(200);
      const withOrigin = await rawRequest(through(rewriting.port), "/api/cs/projects", {
        host: authority(rewriting.port),
        headers: { cookie, origin: `http://${authority(rewriting.port)}` },
      });
      expect(withOrigin.status).toBe(403);
    } finally {
      await Promise.all([plainProxy.close(), trustedProxy.close(), rewriting.close()]);
    }
  } finally {
    await Promise.all([plain.stop(), trusted.stop()]);
  }
}, 60_000);

test("a restart on the same home makes a new login token, and a session cookie stays valid", async () => {
  const home = createTestHome();
  try {
    const port = await freePort();
    const target = { host: LOOPBACK, port };

    const first = await launchDsh({ home, port });
    let oldToken: string;
    let cookie: string;
    try {
      oldToken = tokenOf(first.url);
      const login = await rawRequest(target, `/?token=${oldToken}`);
      cookie = cookieOf(login.headers);
      expect((await rawRequest(target, "/api/cs/projects", { headers: { cookie } })).status).toBe(
        200,
      );
    } finally {
      await first.stop();
    }

    const second = await launchDsh({ home, port });
    try {
      // Hashes only: a token never goes into an assertion message.
      expect(sha256(tokenOf(second.url))).not.toBe(sha256(oldToken));
      expect((await rawRequest(target, `/?token=${oldToken}`)).status).toBe(401);
      // The signing secret lives in the home, so the cookie survives; the same authority is
      // why the port stays fixed.
      expect((await rawRequest(target, "/api/cs/projects", { headers: { cookie } })).status).toBe(
        200,
      );
      expect((await rawRequest(target, `/?token=${tokenOf(second.url)}`)).status).toBeLessThan(400);
    } finally {
      await second.stop();
    }
  } finally {
    home.remove();
  }
}, 60_000);
