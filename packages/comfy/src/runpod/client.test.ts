import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfyError } from "../backend.ts";
import { standIn } from "../testing/support.ts";
import { jobRecordKey, META_OBJECT_INFO_KEY, RunPodClient } from "./client.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** The RunPod job API and the volume's S3 endpoint behind one fake fetch, told apart by host. */
function harness(handler: (url: URL, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetchImpl = standIn<typeof fetch>(
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        headers: { ...standIn<Record<string, string>>(init?.headers) },
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return handler(url, init ?? {});
    }),
  );
  const client = new RunPodClient(
    {
      baseUrl: "https://api.runpod.ai/v2/ep1/",
      apiKey: "rpa_key",
      volume: {
        endpoint: "https://s3api-eu-ro-1.runpod.io",
        region: "EU-RO-1",
        bucket: "vol1",
        accessKeyId: "user_a",
        secretAccessKey: "rps_b",
      },
    },
    fetchImpl,
  );
  return { client, calls };
}

const HEALTH = {
  jobs: { completed: 3, failed: 0, inProgress: 1, inQueue: 2, retried: 0 },
  workers: { idle: 0, initializing: 1, ready: 1, running: 1, throttled: 0, unhealthy: 0 },
};
const WORKER = {
  image: "ghcr.io/example/worker:1.0.0",
  comfyui_version: "0.39.0",
  devices: ["Example GPU"],
  written_at: "2026-01-01T00:00:00Z",
};

afterEach(() => vi.restoreAllMocks());

describe("RunPodClient.systemStats", () => {
  it("proves the API key with /health and the volume key with meta/worker.json", async () => {
    const { client, calls } = harness((url) => {
      if (url.host === "api.runpod.ai") return Response.json(HEALTH);
      if (url.pathname === "/vol1/meta/worker.json") return Response.json(WORKER);
      return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    });
    const stats = await client.systemStats();
    expect(stats).toMatchObject({
      comfyuiVersion: "0.39.0",
      devices: [{ name: "Example GPU", type: "cuda" }],
    });
    expect(stats.note).toContain("워커 대기 0 · 실행 1");
    expect(stats.note).toContain("초기화 1");
    expect(stats.note).toContain("작업 큐 2 · 진행 1");
    expect(stats.note).toContain("ghcr.io/example/worker:1.0.0");
    const health = calls.find((c) => c.url.includes("api.runpod.ai"))!;
    expect(health.url).toBe("https://api.runpod.ai/v2/ep1/health");
    expect(health.headers.Authorization).toBe("Bearer rpa_key");
    const meta = calls.find((c) => c.url.includes("s3api"))!;
    expect(meta.headers.authorization).toContain("Credential=user_a/");
    expect(meta.headers.Authorization).toBeUndefined();
  });

  it("works before the worker ever ran (no meta yet), saying so", async () => {
    const { client } = harness((url) =>
      url.host === "api.runpod.ai"
        ? Response.json({ jobs: {}, workers: {} })
        : new Response("", { status: 404 }),
    );
    const stats = await client.systemStats();
    expect(stats.comfyuiVersion).toBeNull();
    expect(stats.note).toContain("워커 기록 없음");
  });

  it("reports a bad API key and a bad S3 key distinctly", async () => {
    const { client: badApi } = harness((url) =>
      url.host === "api.runpod.ai"
        ? new Response('{"error":"Unauthorized"}', { status: 401 })
        : Response.json(WORKER),
    );
    const apiErr = await badApi.systemStats().catch((e: unknown) => e);
    expect(apiErr).toBeInstanceOf(ComfyError);
    expect(standIn<ComfyError>(apiErr).message).toContain("API 키");

    const { client: badS3 } = harness((url) =>
      url.host === "api.runpod.ai"
        ? Response.json(HEALTH)
        : new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
    );
    const s3Err = await badS3.systemStats().catch((e: unknown) => e);
    expect(s3Err).toBeInstanceOf(ComfyError);
    expect(standIn<ComfyError>(s3Err).message).toContain("S3 키");
  });

  it("turns an unknown endpoint into a readable error", async () => {
    const { client } = harness(
      () => new Response('{"error":"endpoint not found"}', { status: 404 }),
    );
    await expect(client.systemStats()).rejects.toThrow("endpoint not found");
  });
});

const RESULT = {
  images: [
    { node_id: "9", filename: "a.png", subfolder: "", type: "volume", data: "a.png" },
    { node_id: "12", filename: "v.mp4", subfolder: "vid", type: "volume", data: "vid/v.mp4" },
  ],
  output_dir: "/runpod-volume/output",
};

describe("RunPodClient jobs", () => {
  it("submits the graph as the handler's workflow and returns the job id", async () => {
    const { client, calls } = harness(() => Response.json({ id: "job-1", status: "IN_QUEUE" }));
    expect(await client.queuePrompt({ "3": { class_type: "KSampler", inputs: {} } })).toBe("job-1");
    const run = calls[0]!;
    expect(run.url).toBe("https://api.runpod.ai/v2/ep1/run");
    expect(run.method).toBe("POST");
    expect(JSON.parse(run.body!)).toEqual({
      input: { workflow: { "3": { class_type: "KSampler", inputs: {} } } },
    });
  });

  it("maps status to the runner's result, carrying polled progress", async () => {
    let status: unknown = { status: "IN_PROGRESS", output: { node: "3", value: 2, max: 20 } };
    const { client } = harness(() => Response.json(status));
    expect(await client.result("job-1")).toEqual({
      state: "pending",
      progress: { node: "3", value: 2, max: 20 },
    });
    status = { status: "COMPLETED", output: RESULT };
    expect(await client.result("job-1")).toEqual({
      state: "succeeded",
      files: [
        { nodeId: "9", filename: "a.png", subfolder: "", type: "output", volumePath: "a.png" },
        {
          nodeId: "12",
          filename: "v.mp4",
          subfolder: "vid",
          type: "output",
          volumePath: "vid/v.mp4",
        },
      ],
    });
    status = { status: "FAILED", output: { error: "Error queuing workflow", details: "bad ckpt" } };
    expect(await client.result("job-1")).toEqual({
      state: "failed",
      error: "Error queuing workflow: bad ckpt",
    });
    status = { status: "CANCELLED" };
    expect(await client.result("job-1")).toEqual({ state: "interrupted" });
  });

  it("falls back to the handler's job record once RunPod has forgotten the job", async () => {
    const record = { id: "job-old", finished_at: 1, output: RESULT };
    const { client, calls } = harness((url) => {
      if (url.host === "api.runpod.ai")
        return new Response('{"error":"not found"}', { status: 404 });
      if (url.pathname === `/vol1/${jobRecordKey("job-old")}`) return Response.json(record);
      return new Response("", { status: 404 });
    });
    const res = await client.result("job-old");
    expect(res.state).toBe("succeeded");
    expect(calls.map((c) => c.url)).toContain(
      "https://s3api-eu-ro-1.runpod.io/vol1/output/_jobs/job-old.json",
    );
    // COMPLETED without output goes the same way; without a record either, it is a failure.
    const { client: gone } = harness((url) =>
      url.host === "api.runpod.ai"
        ? Response.json({ status: "COMPLETED" })
        : new Response("", { status: 404 }),
    );
    expect(await gone.result("job-gone")).toMatchObject({ state: "failed" });
  });

  it("cancels through /cancel and reports what the status says", async () => {
    let status = "CANCELLED";
    const { client, calls } = harness((url) =>
      url.pathname.endsWith("/cancel/job-1")
        ? Response.json({ id: "job-1", status: "CANCELLED" })
        : Response.json({ status }),
    );
    expect(await client.cancel("job-1")).toBe("canceled");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.runpod.ai/v2/ep1/cancel/job-1",
    });
    status = "COMPLETED";
    expect(await client.cancel("job-1")).toBe("finished");
    status = "IN_PROGRESS";
    expect(await client.cancel("job-1")).toBe("running");
  });

  it("streams outputs and inputs from the volume, naming the type from the file when S3 does not", async () => {
    const { client, calls } = harness((url) =>
      url.pathname === "/vol1/output/vid/v.mp4"
        ? new Response("movie", { headers: { "content-type": "binary/octet-stream" } })
        : url.pathname === "/vol1/input/ref.png"
          ? new Response("png", { headers: { "content-type": "image/png" } })
          : new Response("", { status: 404 }),
    );
    const out = await client.view({
      filename: "v.mp4",
      subfolder: "vid",
      type: "output",
      volumePath: "vid/v.mp4",
    });
    expect(out.contentType).toBe("video/mp4");
    expect(await new Response(out.body).text()).toBe("movie");
    const input = await client.view({ filename: "ref.png", subfolder: "", type: "input" });
    expect(input.contentType).toBe("image/png");
    expect(calls.at(-1)!.url).toBe("https://s3api-eu-ro-1.runpod.io/vol1/input/ref.png");
    const missing = await client
      .view({ filename: "x.png", subfolder: "", type: "input" })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ComfyError);
    expect(standIn<ComfyError>(missing).status).toBe(404);
    await expect(client.view({ filename: "x.png", subfolder: "", type: "output" })).rejects.toThrow(
      "볼륨 경로",
    );
  });

  it("releases a run's outputs and its record from the volume", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 204 }));
    await client.releaseOutputs("job-1", [
      { nodeId: "9", filename: "a.png", subfolder: "", type: "output", volumePath: "a.png" },
      { nodeId: "9", filename: "b.png", subfolder: "", type: "output" },
    ]);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "DELETE /vol1/output/a.png",
      "DELETE /vol1/output/_jobs/job-1.json",
    ]);
  });
});

const SNAPSHOT = {
  KSampler: { input: { required: { steps: ["INT", { min: 1, max: 100 }] } } },
  LoadImage: { input: { required: { image: [["old.png"], { image_upload: true }] } } },
};

function listXml(keys: string[]) {
  return (
    "<ListBucketResult>" +
    keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join("") +
    "<IsTruncated>false</IsTruncated></ListBucketResult>"
  );
}

describe("RunPodClient node info and inputs", () => {
  it("reads node definitions from the volume snapshot, with live input files, cached by ETag", async () => {
    let etag = '"v1"';
    const { client, calls } = harness((url, init) => {
      if (url.pathname === `/vol1/${META_OBJECT_INFO_KEY}`) {
        if (init.method === "HEAD") return new Response(null, { status: 200, headers: { etag } });
        return Response.json(SNAPSHOT, { headers: { etag } });
      }
      if (url.pathname === "/vol1" && url.searchParams.get("list-type") === "2")
        return new Response(listXml(["input/ref.png", "input/sub/x.png"]), {
          headers: { "content-type": "application/xml" },
        });
      return new Response("", { status: 404 });
    });
    const info = await client.objectInfo(["KSampler", "LoadImage", "Nope"]);
    expect(Object.keys(info).toSorted()).toEqual(["KSampler", "LoadImage"]);
    expect(info.KSampler!.input!.required!.steps).toEqual(["INT", { min: 1, max: 100 }]);
    expect(info.LoadImage!.input!.required!.image).toEqual([["ref.png"], { image_upload: true }]);
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("object_info"))).toHaveLength(
      1,
    );

    // Same ETag: HEAD only, no re-download. No image inputs asked: no listing either.
    calls.length = 0;
    await client.objectInfo(["KSampler"]);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `HEAD /vol1/${META_OBJECT_INFO_KEY}`,
    ]);

    // New ETag: downloaded again.
    etag = '"v2"';
    calls.length = 0;
    await client.objectInfo(["KSampler"]);
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("object_info"))).toHaveLength(
      1,
    );
  });

  it("lists the whole snapshot with live input files", async () => {
    const { client, calls } = harness((url, init) => {
      if (url.pathname === `/vol1/${META_OBJECT_INFO_KEY}`) {
        if (init.method === "HEAD")
          return new Response(null, { status: 200, headers: { etag: '"v1"' } });
        return Response.json(SNAPSHOT, { headers: { etag: '"v1"' } });
      }
      if (url.pathname === "/vol1" && url.searchParams.get("list-type") === "2")
        return new Response(listXml(["input/ref.png"]), {
          headers: { "content-type": "application/xml" },
        });
      return new Response("", { status: 404 });
    });
    const all = await client.listNodeClasses();
    expect(Object.keys(all).toSorted()).toEqual(["KSampler", "LoadImage"]);
    expect(all.LoadImage!.input!.required!.image).toEqual([["ref.png"], { image_upload: true }]);
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("object_info"))).toHaveLength(
      1,
    );
    await expect(
      harness(() => new Response(null, { status: 404 })).client.listNodeClasses(),
    ).rejects.toBeInstanceOf(ComfyError);
  });

  it("says so when the volume has no snapshot yet", async () => {
    const { client } = harness(() => new Response(null, { status: 404 }));
    const err = await client.objectInfo(["KSampler"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyError);
    expect(standIn<ComfyError>(err).message).toContain("meta/object_info.json");
  });

  it("uploads inputs to the top of input/ under a unique name", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 200 }));
    const name = await client.uploadImage(
      new Blob([new Uint8Array([1, 2])], { type: "image/png" }),
      "cat.png",
    );
    expect(name).toMatch(/^cat-[\w-]{6}\.png$/);
    expect(name).not.toContain("/");
    const put = calls[0]!;
    expect(put.method).toBe("PUT");
    expect(new URL(put.url).pathname).toBe(`/vol1/input/${name}`);
    expect(put.headers["content-type"]).toBe("image/png");
    expect(put.headers["content-length"]).toBe("2");
    const second = await client.uploadImage(new Blob([new Uint8Array([1])]), "cat.png");
    expect(second).not.toBe(name);
  });
});
