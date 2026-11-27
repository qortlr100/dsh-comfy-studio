import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfyError } from "../backend.ts";
import { standIn } from "../testing/support.ts";
import { ModalClient, parseProxyToken } from "./client.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

const BASE = "https://example--gateway-api.modal.run";

/** The gateway behind a fake fetch; `handler` answers by path. */
function harness(handler: (url: URL, init: RequestInit) => Response, baseUrl = `${BASE}/gpu-a/`) {
  const calls: Call[] = [];
  const fetchImpl = standIn<typeof fetch>(
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        headers: { ...standIn<Record<string, string>>(init?.headers) },
        body: init?.body,
      });
      return handler(url, init ?? {});
    }),
  );
  const client = new ModalClient({ baseUrl, token: "wk-abc:ws-xyz" }, fetchImpl);
  return { client, calls };
}

const LOAD_IMAGE = {
  LoadImage: {
    input: { required: { image: [["stale.png"], { image_upload: true }] } },
    output: ["IMAGE", "MASK"],
    name: "LoadImage",
  },
  KSampler: { input: { required: { seed: ["INT", { default: 0 }] } }, output: ["LATENT"] },
};

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "csModalObjectInfo");
});

describe("parseProxyToken", () => {
  it("takes id:secret, or the two pasted with whitespace between", () => {
    expect(parseProxyToken("wk-abc:ws-xyz")).toEqual({ id: "wk-abc", secret: "ws-xyz" });
    expect(parseProxyToken(" wk-abc \n ws-xyz ")).toEqual({ id: "wk-abc", secret: "ws-xyz" });
    expect(parseProxyToken("wk-abc")).toBeNull();
    expect(parseProxyToken("a:b:c")).toBeNull();
  });

  it("refuses to build a client without both halves", () => {
    expect(() => new ModalClient({ baseUrl: BASE, token: "wk-only" })).toThrow(ComfyError);
  });
});

describe("ModalClient.systemStats", () => {
  it("reads /health under the profile path with the proxy token headers", async () => {
    const { client, calls } = harness(() =>
      Response.json({
        app: "worker",
        profile: "gpu-a",
        gpu: "GPU-A",
        highvram: true,
        snapshot: true,
        worker: {
          image: "ghcr.io/example/worker:1.0.0",
          comfyui_version: "0.39.0",
          devices: ["Example GPU"],
        },
      }),
    );
    const stats = await client.systemStats();
    expect(stats).toMatchObject({
      comfyuiVersion: "0.39.0",
      devices: [{ name: "Example GPU", type: "cuda" }],
    });
    expect(stats.note).toBe("GPU GPU-A · 이미지 ghcr.io/example/worker:1.0.0");
    expect(calls[0]!.url).toBe(`${BASE}/gpu-a/health`);
    expect(calls[0]!.headers["Modal-Key"]).toBe("wk-abc");
    expect(calls[0]!.headers["Modal-Secret"]).toBe("ws-xyz");
  });

  it("says so before the worker ever started", async () => {
    const { client } = harness(() =>
      Response.json({ gpu: "GPU-B", highvram: false, snapshot: false, worker: null }),
    );
    const stats = await client.systemStats();
    expect(stats.comfyuiVersion).toBeNull();
    expect(stats.note).toBe(
      "GPU GPU-B · highvram 끔 · 볼륨에 워커 기록 없음(첫 실행 뒤 생김) · 노드 정보 스냅샷 없음",
    );
  });

  it("turns a rejected token into a readable error", async () => {
    const { client } = harness(
      () => new Response("modal-http: invalid credentials", { status: 401 }),
    );
    await expect(client.systemStats()).rejects.toThrow("Modal 인증에 실패했습니다");
  });
});

describe("ModalClient jobs", () => {
  it("submits the graph as input.workflow and returns the call id", async () => {
    const { client, calls } = harness(() => Response.json({ id: "fc-01", status: "IN_QUEUE" }));
    const id = await client.queuePrompt({ "1": { class_type: "KSampler", inputs: {} } });
    expect(id).toBe("fc-01");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/gpu-a/run`);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      input: { workflow: { "1": { class_type: "KSampler", inputs: {} } } },
    });
  });

  it("maps /status to run states, with progress and volume outputs", async () => {
    const answers: Record<string, unknown> = {
      "fc-q": { status: "IN_QUEUE" },
      "fc-p": { status: "IN_PROGRESS", output: { node: "3", value: 4, max: 20 } },
      "fc-c": { status: "CANCELLED" },
      "fc-f": { status: "FAILED", error: "KSampler: CUDA out of memory" },
      "fc-t": { status: "TIMED_OUT" },
      "fc-gone": { status: "COMPLETED", output: null },
      "fc-ok": {
        status: "COMPLETED",
        output: {
          images: [
            {
              node_id: "9",
              output_key: "images",
              filename: "img_00001.png",
              subfolder: "out/run1",
              type: "volume",
              data: "out/run1/img_00001.png",
            },
          ],
        },
      },
    };
    const { client } = harness((url) => {
      const id = url.pathname.split("/").pop()!;
      return id in answers
        ? Response.json(answers[id])
        : Response.json({ detail: "작업을 찾을 수 없습니다" }, { status: 404 });
    });
    expect(await client.result("fc-q")).toEqual({ state: "pending", progress: null });
    expect(await client.result("fc-p")).toEqual({
      state: "pending",
      progress: { node: "3", value: 4, max: 20 },
    });
    expect(await client.result("fc-c")).toEqual({ state: "interrupted" });
    expect(await client.result("fc-f")).toEqual({
      state: "failed",
      error: "KSampler: CUDA out of memory",
    });
    expect(await client.result("fc-t")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("Modal 실행 시간 제한"),
    });
    expect(await client.result("fc-gone")).toMatchObject({ state: "failed" });
    expect(await client.result("fc-missing")).toEqual({
      state: "failed",
      error: "Modal이 이 작업을 찾지 못했습니다",
    });
    expect(await client.result("fc-ok")).toEqual({
      state: "succeeded",
      files: [
        {
          nodeId: "9",
          filename: "img_00001.png",
          subfolder: "out/run1",
          type: "output",
          volumePath: "out/run1/img_00001.png",
        },
      ],
    });
  });

  it("throws on a gateway hiccup, so the runner keeps tracking the run", async () => {
    const { client } = harness(() => new Response("upstream", { status: 502 }));
    await expect(client.result("fc-1")).rejects.toThrow(ComfyError);
  });

  it("reads the cancel answer as the outcome", async () => {
    const answers: Record<string, unknown> = {
      "fc-a": { status: "CANCELLED" },
      "fc-b": { status: "COMPLETED", output: { images: [] } },
      "fc-c": { status: "FAILED", error: "x" },
    };
    const { client, calls } = harness((url) =>
      Response.json(answers[url.pathname.split("/").pop()!]),
    );
    expect(await client.cancel("fc-a")).toBe("canceled");
    expect(await client.cancel("fc-b")).toBe("finished");
    expect(await client.cancel("fc-c")).toBe("finished");
    expect(calls.every((c) => c.method === "POST" && c.url.includes("/gpu-a/cancel/"))).toBe(true);
  });
});

describe("ModalClient node info", () => {
  it("serves the snapshot with live input names, revalidating by ETag", async () => {
    let snapshotReads = 0;
    const { client, calls } = harness((url, init) => {
      if (url.pathname.endsWith("/object_info")) {
        const etag = '"1730000000-1234"';
        if (standIn<Record<string, string>>(init.headers)["If-None-Match"] === etag)
          return new Response(null, { status: 304, headers: { ETag: etag } });
        snapshotReads++;
        return Response.json(LOAD_IMAGE, { headers: { ETag: etag } });
      }
      if (url.pathname.endsWith("/inputs"))
        return Response.json({ files: ["b.png", "a.png", "song.mp3"] });
      return new Response("", { status: 404 });
    });
    const first = await client.objectInfo(["LoadImage"]);
    expect(Object.keys(first)).toEqual(["LoadImage"]);
    expect(first.LoadImage!.input!.required!.image![0]).toEqual(["a.png", "b.png"]);
    const all = await client.listNodeClasses();
    expect(Object.keys(all).toSorted()).toEqual(["KSampler", "LoadImage"]);
    expect(snapshotReads).toBe(1);
    const reval = calls.filter((c) => c.url.endsWith("/object_info"));
    expect(reval[1]!.headers["If-None-Match"]).toBe('"1730000000-1234"');
  });

  it("explains a missing snapshot", async () => {
    const { client } = harness(() => Response.json({ detail: "no snapshot" }, { status: 404 }));
    await expect(client.objectInfo(["KSampler"])).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("meta/object_info.json"),
    });
  });
});

describe("ModalClient files", () => {
  it("uploads under a unique name at the top of input/", async () => {
    const { client, calls } = harness(() => Response.json({ name: "x", size: 3 }));
    const name = await client.uploadImage(new Blob(["abc"], { type: "image/png" }), "my cat.png");
    expect(name).toMatch(/^my cat-[\w-]{6}\.png$/);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`${BASE}/gpu-a/inputs/${encodeURIComponent(name)}`);
    expect(calls[0]!.headers["Content-Type"]).toBe("image/png");
  });

  it("streams outputs by volume path, typing them by name when the gateway does not", async () => {
    const { client, calls } = harness(
      () =>
        new Response("RIFF", {
          headers: { "Content-Type": "application/octet-stream", "Content-Length": "4" },
        }),
    );
    const got = await client.view({
      filename: "clip 1.mp4",
      subfolder: "out/run1",
      type: "output",
      volumePath: "out/run1/clip 1.mp4",
    });
    expect(got.contentType).toBe("video/mp4");
    expect(await new Response(got.body).text()).toBe("RIFF");
    expect(calls[0]!.url).toBe(`${BASE}/gpu-a/files/output/out/run1/clip%201.mp4`);
  });

  it("refuses outputs over the size cap before reading them", async () => {
    const { client } = harness(
      () => new Response("x", { headers: { "Content-Length": String(600 * 1024 * 1024) } }),
    );
    await expect(
      client.view({ filename: "a.png", subfolder: "", type: "output", volumePath: "a.png" }),
    ).rejects.toThrow("출력 파일이 너무 큽니다");
  });

  it("reads inputs by name and rejects subfolders", async () => {
    const { client, calls } = harness(
      () => new Response("png", { headers: { "Content-Type": "image/png" } }),
    );
    const got = await client.view({ filename: "a.png", subfolder: "", type: "input" });
    expect(got.contentType).toBe("image/png");
    expect(calls[0]!.url).toBe(`${BASE}/gpu-a/files/input/a.png`);
    await expect(client.view({ filename: "a.png", subfolder: "x", type: "input" })).rejects.toThrow(
      ComfyError,
    );
  });

  it("releases outputs, then the job record", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 204 }));
    await client.releaseOutputs("fc-9", [
      { nodeId: "9", filename: "a.png", subfolder: "", type: "output", volumePath: "a.png" },
      { nodeId: "9", filename: "b.png", subfolder: "", type: "output" },
    ]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${BASE}/gpu-a/files/output/a.png`,
      `DELETE ${BASE}/gpu-a/jobs/fc-9`,
    ]);
  });
});
