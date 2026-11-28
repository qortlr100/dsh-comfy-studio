/**
 * The asset routes over a real store in a temporary folder and a recording project stand-in: file serving with ranges
 * and type hiding, thumbnails, the upload (validation, limit, temporary file, `asset.import` and `asset.move` calls)
 * and the stage route (bytes only).
 */
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProjectError, type AssetId, type RunRequest, type RunResult } from "@cs/project";
import { standIn } from "@cs/project/testing/support";
import { assetRoutes, type RouteDeps } from "./routes.ts";
import { fakeFfmpeg, idOf, testStore } from "./testing/files.ts";
import { Thumbnails } from "./thumbs.ts";
import { ASSET_ROUTES } from "./types.ts";

const ORIGIN = "http://localhost";

/** Everything a route test needs. */
function setup(overrides: Partial<RouteDeps> = {}) {
  const store = testStore();
  const project = store.addProject("p1");
  const ffmpeg = fakeFfmpeg();
  const runs: RunRequest[] = [];
  const internal: unknown[] = [];
  const probed: AssetId[] = [];
  const thumbs = new Thumbnails({
    entry: (asset) => store.files.find(asset),
    path: (asset) => store.files.path(asset),
    thumbPath: (asset) => store.files.thumbPath(asset),
    ffmpeg: () => ffmpeg,
    warn: () => undefined,
  });
  const deps: RouteDeps = {
    files: store.files,
    thumbs,
    project: {
      openProject: (id) => {
        if (id !== project) throw new ProjectError("unknown_project", `Unknown project '${id}'.`);
        return {};
      },
      run: (request) => {
        runs.push(request);
        return Promise.resolve(
          standIn<RunResult>({
            record: { id: `rec-${String(runs.length)}` },
            outputs: [],
            report: null,
          }),
        );
      },
    },
    probe: (asset) => {
      probed.push(asset);
      return Promise.resolve();
    },
    maxUploadBytes: 1000,
    onInternalError: (error) => internal.push(error),
    ...overrides,
  };
  const routes = assetRoutes(deps);
  /** Call the route of a path. */
  const call = (path: string, url: string, init: RequestInit = {}): Promise<Response> => {
    const route = routes.find((candidate) => candidate.path === path);
    if (route === undefined) throw new Error(`No route ${path}`);
    return route.fetch(new Request(`${ORIGIN}${url}`, init));
  };
  const put = (bytes: Uint8Array, mime: string, name: string): AssetId =>
    store.files.importAsset(project, bytes, { mime, name }, null);
  return { store, project, runs, internal, probed, ffmpeg, routes, call, put };
}

/** The upload directories of this process that exist now. */
function uploadDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("cs-asset-upload-"));
}

const BYTES = new Uint8Array(Array.from({ length: 100 }, (_, index) => index));

const query = (project: string, extra = "") =>
  `?project=${project}&name=pic.png&mime=image%2Fpng${extra}`;

describe("route table", () => {
  it("registers the four routes with the plan's methods and body modes", () => {
    const { routes } = setup();
    expect(routes.map((route) => [route.path, route.methods.join("|"), route.requestBody])).toEqual(
      [
        [ASSET_ROUTES.file, "GET|HEAD", "buffered"],
        [ASSET_ROUTES.thumb, "GET|HEAD", "buffered"],
        [ASSET_ROUTES.upload, "POST", "streaming"],
        [ASSET_ROUTES.stage, "POST", "streaming"],
      ],
    );
  });
});

describe("file route", () => {
  it("serves the whole file with the cache and safety headers", async () => {
    const { call, put } = setup();
    const id = put(BYTES, "image/png", "a b.png");
    const response = await call(ASSET_ROUTES.file, `/api/cs/asset?id=${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("answers HEAD without a body", async () => {
    const { call, put } = setup();
    const id = put(BYTES, "image/png", "a.png");
    const response = await call(ASSET_ROUTES.file, `/api/cs/asset?id=${id}`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("100");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it.each([
    ["bytes=10-19", 10, 19],
    ["bytes=90-", 90, 99],
    ["bytes=-5", 95, 99],
    ["bytes=95-500", 95, 99],
    ["bytes=0-0", 0, 0],
  ])("serves %s as 206", async (header, start, end) => {
    const { call, put } = setup();
    const id = put(BYTES, "video/mp4", "v.mp4");
    const response = await call(ASSET_ROUTES.file, `/api/cs/asset?id=${id}`, {
      headers: { range: header },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${String(start)}-${String(end)}/100`);
    expect(response.headers.get("content-length")).toBe(String(end - start + 1));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(start, end + 1));
  });

  it.each([
    "bytes=100-",
    "bytes=200-300",
    "bytes=-0",
    "bytes=5-2",
    "bytes=abc",
    "items=0-1",
    "bytes=-",
  ])("refuses %s with 416", async (header) => {
    const { call, put } = setup();
    const id = put(BYTES, "video/mp4", "v.mp4");
    const response = await call(ASSET_ROUTES.file, `/api/cs/asset?id=${id}`, {
      headers: { range: header },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
  });

  it("serves the whole file when several ranges are asked", async () => {
    const { call, put } = setup();
    const id = put(BYTES, "video/mp4", "v.mp4");
    const response = await call(ASSET_ROUTES.file, `/api/cs/asset?id=${id}`, {
      headers: { range: "bytes=0-1,5-6" },
    });
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it.each([
    ["text/html", "page.html"],
    ["image/svg+xml", "pic.svg"],
    ["application/javascript", "x.js"],
    ["text/plain", "t.txt"],
  ])("hides %s as an attachment of unknown type", async (mime, name) => {
    const { call, put } = setup();
    const id = put(new TextEncoder().encode(`<script>1</script>${name}`), mime, name);
    const response = await call(ASSET_ROUTES.file, `/api/cs/asset?id=${id}`);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${name}`,
    );
  });

  it("encodes the file name of an attachment", async () => {
    const { call, put } = setup();
    const id = put(BYTES, "text/html", "한글 (1).html");
    const response = await call(ASSET_ROUTES.file, `/api/cs/asset?id=${id}`);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("한글 ")}%281%29.html`,
    );
  });

  it("forces an attachment of a drawable type with download=1", async () => {
    const { call, put } = setup();
    const id = put(BYTES, "image/png", "a.png");
    const response = await call(ASSET_ROUTES.file, `/api/cs/asset?id=${id}&download=1`);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''a.png");
  });

  it("answers 404 unknown_asset for an unknown ID and 400 for a malformed one", async () => {
    const { call } = setup();
    const unknown = await call(ASSET_ROUTES.file, `/api/cs/asset?id=${idOf("none")}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "unknown_asset" });
    const malformed = await call(ASSET_ROUTES.file, "/api/cs/asset?id=../../etc/passwd");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_params" });
    expect((await call(ASSET_ROUTES.file, "/api/cs/asset")).status).toBe(400);
  });
});

describe("thumb route", () => {
  it("serves the WebP thumbnail of an image and HEAD without a body", async () => {
    const { call, put } = setup();
    const id = put(BYTES, "image/png", "a.png");
    const response = await call(ASSET_ROUTES.thumb, `/api/cs/asset/thumb?id=${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await response.text()).toBe("RIFFfakewebp");
    const head = await call(ASSET_ROUTES.thumb, `/api/cs/asset/thumb?id=${id}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("answers 404 for a file that has no thumbnail and for an unknown asset", async () => {
    const { call, put, ffmpeg } = setup();
    const text = put(BYTES, "text/plain", "t.txt");
    expect((await call(ASSET_ROUTES.thumb, `/api/cs/asset/thumb?id=${text}`)).status).toBe(404);
    expect((await call(ASSET_ROUTES.thumb, `/api/cs/asset/thumb?id=${idOf("none")}`)).status).toBe(
      404,
    );
    const image = put(new Uint8Array([1]), "image/png", "b.png");
    ffmpeg.failWith = "no";
    expect((await call(ASSET_ROUTES.thumb, `/api/cs/asset/thumb?id=${image}`)).status).toBe(404);
  });
});

describe("upload route", () => {
  it("stores the bytes, probes them, and runs asset.import as the user", async () => {
    const { call, store, project, runs, probed } = setup();
    const before = uploadDirs();
    const response = await call(ASSET_ROUTES.upload, ASSET_ROUTES.upload + query(project), {
      method: "POST",
      body: BYTES,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const id = idOf(BYTES);
    expect(body).toEqual({ asset: id, record: { id: "rec-1" } });
    expect(store.files.get(id)).toMatchObject({
      name: "pic.png",
      mime: "image/png",
      created_by: null,
    });
    expect(probed).toEqual([id]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      project,
      operation: "asset.import",
      params: {},
      inputs: [{ role: "file", ref: { asset: id } }],
      actor: "user",
      surface: "view",
      session: null,
      turn: null,
      tool_call: null,
      intent: "upload pic.png",
    });
    expect(uploadDirs()).toEqual(before);
  });

  it("takes surface, session and folder from the query and then moves the asset", async () => {
    const { call, project, runs } = setup();
    const response = await call(
      ASSET_ROUTES.upload,
      ASSET_ROUTES.upload + query(project, "&surface=chat&session=s9&folder=fold1"),
      { method: "POST", body: BYTES },
    );
    expect(response.status).toBe(200);
    expect(runs.map((run) => run.operation)).toEqual(["asset.import", "asset.move"]);
    expect(runs[0]).toMatchObject({ surface: "chat", session: "s9" });
    expect(runs[1]).toMatchObject({
      params: { folder: "fold1" },
      inputs: [{ role: "asset", ref: { asset: idOf(BYTES) } }],
      actor: "user",
    });
  });

  it.each([
    ["no project", "?name=a.png&mime=image%2Fpng"],
    ["no name", "?project=p1&mime=image%2Fpng"],
    ["empty name", "?project=p1&name=&mime=image%2Fpng"],
    ["a path in the name", "?project=p1&name=..%2Fa.png&mime=image%2Fpng"],
    ["a backslash in the name", "?project=p1&name=a%5Cb.png&mime=image%2Fpng"],
    ["a control character in the name", "?project=p1&name=a%00b&mime=image%2Fpng"],
    ["a name over 200 characters", `?project=p1&name=${"a".repeat(201)}&mime=image%2Fpng`],
    ["no mime", "?project=p1&name=a.png"],
    ["a malformed mime", "?project=p1&name=a.png&mime=png"],
  ])("answers 400 invalid_params for %s without storing anything", async (_label, search) => {
    const { call, runs, store } = setup();
    const before = uploadDirs();
    const response = await call(ASSET_ROUTES.upload, ASSET_ROUTES.upload + search, {
      method: "POST",
      body: BYTES,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_params" });
    expect(runs).toHaveLength(0);
    expect(store.files.has(idOf(BYTES))).toBe(false);
    expect(uploadDirs()).toEqual(before);
  });

  it("answers 404 for an unknown project", async () => {
    const { call } = setup();
    const response = await call(ASSET_ROUTES.upload, ASSET_ROUTES.upload + query("nope"), {
      method: "POST",
      body: BYTES,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "unknown_project" });
  });

  it("answers 413 over the limit and removes the temporary file", async () => {
    const { call, project, store, runs } = setup({ maxUploadBytes: 50 });
    const before = uploadDirs();
    const response = await call(ASSET_ROUTES.upload, ASSET_ROUTES.upload + query(project), {
      method: "POST",
      body: BYTES,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large" });
    expect(store.files.has(idOf(BYTES))).toBe(false);
    expect(runs).toHaveLength(0);
    expect(uploadDirs()).toEqual(before);
  });

  it("answers 413 from a declared length before reading the body", async () => {
    const { call, project } = setup({ maxUploadBytes: 50 });
    const response = await call(ASSET_ROUTES.upload, ASSET_ROUTES.upload + query(project), {
      method: "POST",
      body: BYTES,
      headers: { "content-length": "100" },
    });
    expect(response.status).toBe(413);
  });

  it("maps a refused import to its status and removes the temporary file", async () => {
    const { call, project } = setup({
      project: {
        openProject: () => ({}),
        run: () => Promise.reject(new ProjectError("invalid_inputs", "no such input")),
      },
    });
    const before = uploadDirs();
    const response = await call(ASSET_ROUTES.upload, ASSET_ROUTES.upload + query(project), {
      method: "POST",
      body: BYTES,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "no such input", code: "invalid_inputs" });
    expect(uploadDirs()).toEqual(before);
  });

  it("answers 409 for a refusal without its own status", async () => {
    const { call, project } = setup({
      project: {
        openProject: () => ({}),
        run: () => Promise.reject(new ProjectError("proposal_busy", "busy")),
      },
    });
    const response = await call(ASSET_ROUTES.upload, ASSET_ROUTES.upload + query(project), {
      method: "POST",
      body: BYTES,
    });
    expect(response.status).toBe(409);
  });

  it("answers 500 internal_error without leaking the message", async () => {
    const { call, project, internal } = setup({
      project: {
        openProject: () => ({}),
        run: () => Promise.reject(new Error("secret path /x/y")),
      },
    });
    const response = await call(ASSET_ROUTES.upload, ASSET_ROUTES.upload + query(project), {
      method: "POST",
      body: BYTES,
    });
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("internal_error");
    expect(body).not.toContain("secret");
    expect(internal).toHaveLength(1);
  });

  it("accepts an empty upload", async () => {
    const { call, project } = setup();
    const response = await call(ASSET_ROUTES.upload, ASSET_ROUTES.upload + query(project), {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ asset: idOf("") });
  });
});

describe("stage route", () => {
  it("stores the bytes and answers the asset without running any operation", async () => {
    const { call, store, project, runs, probed } = setup();
    const before = uploadDirs();
    const response = await call(
      ASSET_ROUTES.stage,
      `${ASSET_ROUTES.stage}?project=${project}&name=s.png&mime=image%2Fpng&folder=ignored`,
      { method: "POST", body: BYTES },
    );
    expect(response.status).toBe(200);
    const id = idOf(BYTES);
    expect(await response.json()).toEqual({ asset: id });
    expect(store.files.get(id)).toMatchObject({ name: "s.png", created_by: null });
    expect(probed).toEqual([id]);
    expect(runs).toHaveLength(0);
    expect(uploadDirs()).toEqual(before);
  });

  it("shares the validation and the limit of the upload", async () => {
    const { call, project } = setup({ maxUploadBytes: 10 });
    const bad = await call(
      ASSET_ROUTES.stage,
      `${ASSET_ROUTES.stage}?project=${project}&name=a&mime=nope`,
      {
        method: "POST",
        body: BYTES,
      },
    );
    expect(bad.status).toBe(400);
    const big = await call(
      ASSET_ROUTES.stage,
      `${ASSET_ROUTES.stage}?project=${project}&name=a&mime=image%2Fpng`,
      {
        method: "POST",
        body: BYTES,
      },
    );
    expect(big.status).toBe(413);
    const unknown = await call(
      ASSET_ROUTES.stage,
      `${ASSET_ROUTES.stage}?project=nope&name=a&mime=image%2Fpng`,
      {
        method: "POST",
        body: new Uint8Array([1]),
      },
    );
    expect(unknown.status).toBe(404);
  });
});
