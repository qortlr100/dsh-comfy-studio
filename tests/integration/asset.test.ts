// The asset component (@cs/asset, stage 2-3b, docs/archive/PLAN_2-3b.md) on a real dsh: a page that
// logged in uploads a file, the library shows it as adopted, the file comes back whole and by
// range, a type that could run script comes back as a download, the agent tags it and the user
// undoes the tag while the import stays, the agent's delete waits for the user, and a request
// without the login cookie reaches nothing.

import { spawnSync } from "node:child_process";
import type { Page } from "playwright-core";
import { afterEach, expect, test } from "vitest";
import type { FakeReply, FakeScript } from "../harness/llm.ts";
import {
  ASSET_TOOLS,
  afterTool,
  agentRequests,
  createProject,
  isTitleRequest,
  removeTempFiles,
  seeText,
  send,
  turnOf,
  visibleChat,
  waitIdle,
  withChat,
} from "./chat-rig.ts";
import type { ListedProject } from "./chat-rig.ts";

afterEach(removeTempFiles);

/** A 1×1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_BASE64, "base64");
const HTML_BASE64 = Buffer.from("<script>window.parent.hacked = true</script>").toString("base64");

/** Whether this machine has ffmpeg, which the store uses for sizes and previews when it is there. */
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;

interface Answer<T> {
  status: number;
  body: T;
}

interface FileAnswer {
  status: number;
  type: string | null;
  range: string | null;
  disposition: string | null;
  sniff: string | null;
  base64: string;
}

interface WireItem {
  id: string;
  origin: string;
  review: string;
  folder: string | null;
  tags: string[];
}

interface WireStateBody {
  head: string;
  assets: Array<{ id: string; mime: string; name: string; url: string; size_bytes?: number }>;
  components: {
    proj: {
      records: Array<{ id: string }>;
      proposals: Record<string, { id: string; operation: string; status: string }>;
    };
    asset: { items: Record<string, WireItem> };
  };
}

function stateOf(page: Page, project: ListedProject): Promise<WireStateBody> {
  return page.evaluate<WireStateBody>(
    `fetch("/api/cs/state?project=${project.id}").then((response) => response.json())`,
  );
}

/** POST bytes from the page, where `fetch` carries the login cookie. */
function postBytes<T>(page: Page, path: string, base64: string): Promise<Answer<T>> {
  return page.evaluate<Answer<T>>(
    `fetch(${JSON.stringify(path)}, {
      method: "POST",
      body: Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0)),
    }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
  );
}

function postJson<T>(page: Page, path: string, body: unknown): Promise<Answer<T>> {
  return page.evaluate<Answer<T>>(
    `fetch(${JSON.stringify(path)}, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ${JSON.stringify(JSON.stringify(body))},
    }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
  );
}

/**
 * GET a file from the page, with an optional `Range`. Past the browser's cache: the files are
 * served as immutable, and the browser would answer a range from the whole file it kept.
 */
function getFile(page: Page, path: string, range?: string): Promise<FileAnswer> {
  return page.evaluate<FileAnswer>(
    `fetch(${JSON.stringify(path)}, {
      cache: "no-store",
      headers: ${JSON.stringify(range === undefined ? {} : { range })},
    })
      .then(async (response) => ({
        status: response.status,
        type: response.headers.get("content-type"),
        range: response.headers.get("content-range"),
        disposition: response.headers.get("content-disposition"),
        sniff: response.headers.get("x-content-type-options"),
        base64: btoa(String.fromCharCode(...new Uint8Array(await response.arrayBuffer()))),
      }))`,
  );
}

test("a page uploads an asset, reads it back, and the agent files it; deleting waits for the user", async () => {
  /** The uploaded asset, which the script's tool calls name. */
  let uploaded = "";
  const script: FakeScript = (request): FakeReply => {
    if (isTitleRequest(request)) return { text: "Asset chat" };
    const turn = turnOf(request);
    if (turn === "tag") {
      return afterTool(request)
        ? { text: "tagged it" }
        : {
            toolCalls: [
              {
                name: "cs_asset_tag",
                arguments: { inputs: { asset: [uploaded] }, add: ["hero"], reason: "file it" },
              },
            ],
          };
    }
    if (turn === "delete") {
      return afterTool(request)
        ? { text: "asked to delete" }
        : {
            toolCalls: [
              {
                name: "cs_asset_delete",
                arguments: { inputs: { asset: [uploaded] }, reason: "the user wants it gone" },
              },
            ],
          };
    }
    return { text: "plain reply" };
  };

  await withChat(script, async ({ dsh, llm, session, page }) => {
    const project = await createProject(page);
    const chat = visibleChat(page);
    const query = `project=${project.id}&name=probe.png&mime=${encodeURIComponent("image/png")}`;

    // Upload: the bytes enter the store and the library, outside the history.
    const before = await stateOf(page, project);
    const upload = await postBytes<{ asset: string; record: { id: string; operation: string } }>(
      page,
      `/api/cs/asset/upload?${query}`,
      PNG_BASE64,
    );
    expect(upload.status).toBe(200);
    expect(upload.body.record).toMatchObject({ operation: "asset.import", actor: "user" });
    uploaded = upload.body.asset;
    expect(uploaded).toMatch(/^[0-9a-f]{64}$/);

    const afterUpload = await stateOf(page, project);
    expect(afterUpload.head).toBe(before.head);
    expect(afterUpload.components.proj.records).toHaveLength(1);
    expect(afterUpload.components.asset.items[uploaded]).toMatchObject({
      id: uploaded,
      origin: "import",
      review: "adopted",
      folder: null,
      tags: [],
    });
    const url = `/api/cs/asset?id=${uploaded}`;
    expect(afterUpload.assets).toContainEqual(
      expect.objectContaining({
        id: uploaded,
        mime: "image/png",
        name: "probe.png",
        url,
        size_bytes: PNG.length,
        ...(HAS_FFMPEG ? { width: 1, height: 1 } : {}),
      }),
    );

    // The file comes back whole and by range.
    const whole = await getFile(page, url);
    expect(whole).toMatchObject({ status: 200, type: "image/png", sniff: "nosniff" });
    expect(whole.base64).toBe(PNG_BASE64);
    const part = await getFile(page, url, "bytes=0-7");
    expect(part).toMatchObject({ status: 206, range: `bytes 0-7/${PNG.length}` });
    expect(part.base64).toBe(PNG.subarray(0, 8).toString("base64"));
    expect((await getFile(page, url, `bytes=${PNG.length}-`)).status).toBe(416);
    expect((await getFile(page, `/api/cs/asset?id=${"0".repeat(64)}`)).status).toBe(404);

    // The preview: a WebP when ffmpeg is there, 404 when it is not.
    const thumb = await getFile(page, `/api/cs/asset/thumb?id=${uploaded}`);
    if (HAS_FFMPEG) expect(thumb).toMatchObject({ status: 200, type: "image/webp" });
    else expect(thumb.status).toBe(404);

    // A type that could run script in our origin comes back as a download of opaque bytes.
    const staged = await postBytes<{ asset: string }>(
      page,
      `/api/cs/asset/stage?project=${project.id}&name=page.html&mime=${encodeURIComponent("text/html")}`,
      HTML_BASE64,
    );
    expect(staged.status).toBe(200);
    const html = await getFile(page, `/api/cs/asset?id=${staged.body.asset}`);
    expect(html).toMatchObject({ status: 200, type: "application/octet-stream", sniff: "nosniff" });
    expect(html.disposition).toMatch(/^attachment/);
    // Staged bytes are in the store, not in the library.
    expect((await stateOf(page, project)).components.asset.items).not.toHaveProperty(
      staged.body.asset,
    );

    // A bad upload is refused before anything is written.
    const bad = await postBytes<{ code: string }>(
      page,
      `/api/cs/asset/upload?project=${project.id}&name=probe.png`,
      PNG_BASE64,
    );
    expect(bad).toMatchObject({ status: 400, body: { code: "invalid_params" } });

    // The agent tags the asset: a step, which the user undoes. The import stays.
    await send(page, "cs-turn:tag file the picture");
    await seeText(chat, "tagged it");
    await waitIdle(page);
    const [first] = agentRequests(llm, "tag");
    if (first === undefined) throw new Error("The turn made no request.");
    expect(first.tools).toEqual(expect.arrayContaining(ASSET_TOOLS));
    expect(first.tools).not.toContain("cs_asset_import");
    expect(first.tools).not.toContain("cs_asset_review");
    const tagged = await stateOf(page, project);
    expect(tagged.components.asset.items[uploaded]?.tags).toEqual(["hero"]);
    expect(tagged.head).not.toBe(before.head);

    const undo = await postJson<{ at: string }>(page, "/api/cs/undo", { project: project.id });
    expect(undo.body.at).toBe(before.head);
    const undone = await stateOf(page, project);
    expect(undone.components.asset.items[uploaded]).toMatchObject({ review: "adopted", tags: [] });

    // The agent's delete is a proposal: the asset stays until the user accepts.
    await send(page, "cs-turn:delete remove the picture");
    await seeText(chat, "asked to delete");
    await waitIdle(page);
    const proposed = await stateOf(page, project);
    expect(proposed.components.asset.items).toHaveProperty(uploaded);
    const [proposal] = Object.values(proposed.components.proj.proposals);
    expect(proposal).toMatchObject({ operation: "asset.delete", status: "pending" });
    if (proposal === undefined) throw new Error("No proposal is listed.");

    const decided = await postJson<{ proposal: { status: string } }>(
      page,
      "/api/cs/proposal/decide",
      { project: project.id, proposal: proposal.id, decision: "accept", surface: "view" },
    );
    expect(decided).toMatchObject({ status: 200, body: { proposal: { status: "accepted" } } });
    const deleted = await stateOf(page, project);
    expect(deleted.components.asset.items).not.toHaveProperty(uploaded);
    // The bytes stay in the store: undo brings the asset back.
    expect((await getFile(page, url)).status).toBe(200);

    // Without the login cookie nothing answers. The origin alone: the login URL's token must not
    // travel with these requests.
    const origin = new URL(dsh.url).origin;
    expect((await fetch(`${origin}${url}`)).status).toBe(401);
    expect((await fetch(`${origin}/api/cs/asset/thumb?id=${uploaded}`)).status).toBe(401);
    const anonymous = await fetch(`${origin}/api/cs/asset/upload?${query}`, {
      method: "POST",
      body: PNG,
    });
    expect(anonymous.status).toBe(401);

    expect(llm.requests.map((request) => request.state)).not.toContain("failed");
    // The page's only complaints are the refusals this test asked for, in order: the range past
    // the end, the unknown asset, the preview without ffmpeg, and the upload without a type.
    expect(session.issues).toEqual(
      [416, 404, ...(HAS_FFMPEG ? [] : [404]), 400].map((status): unknown =>
        expect.stringContaining(`status of ${String(status)}`),
      ),
    );
  });
});
