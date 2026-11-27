import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfyClient, ComfyError } from "./client.ts";
import { standIn } from "./testing/support.ts";

type Call = { url: string; headers: Record<string, string>; body?: string };

function mockFetch(handler: (url: string) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        headers: { ...standIn<Record<string, string> | undefined>(init?.headers) },
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return handler(url);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const cloudClient = () =>
  new ComfyClient({ kind: "cloud", baseUrl: "https://cloud.comfy.org", apiKey: "k" });

describe("ComfyClient", () => {
  it("talks to a local server at the root, with an optional bearer token", async () => {
    const calls = mockFetch(() => Response.json({ system: { comfyui_version: "0.3.60" } }));
    const stats = await new ComfyClient({
      kind: "local",
      baseUrl: "http://gpu:8188/",
      apiKey: "proxy-token",
    }).systemStats();
    expect(stats.comfyuiVersion).toBe("0.3.60");
    expect(calls[0]!.url).toBe("http://gpu:8188/system_stats");
    expect(calls[0]!.headers.Authorization).toBe("Bearer proxy-token");
  });

  it("uses /api and X-API-Key for Comfy Cloud, also when the URL already ends in /api", async () => {
    const calls = mockFetch(() => Response.json({ prompt_id: "abc", node_errors: {} }));
    const client = new ComfyClient({
      kind: "cloud",
      baseUrl: "https://cloud.comfy.org/api",
      apiKey: "cloud-key",
    });
    expect(await client.queuePrompt({}, "c1")).toBe("abc");
    expect(calls[0]!.url).toBe("https://cloud.comfy.org/api/prompt");
    expect(calls[0]!.headers["X-API-Key"]).toBe("cloud-key");
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("sends the Cloud key in extra_data for Partner Nodes, never for local servers", async () => {
    const calls = mockFetch(() => Response.json({ prompt_id: "abc", node_errors: {} }));
    await new ComfyClient({
      kind: "cloud",
      baseUrl: "https://cloud.comfy.org",
      apiKey: "cloud-key",
    }).queuePrompt({}, "c1");
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      extra_data: { api_key_comfy_org: "cloud-key" },
    });
    await new ComfyClient({
      kind: "local",
      baseUrl: "http://gpu:8188",
      apiKey: "proxy-token",
    }).queuePrompt({}, "c1");
    expect(JSON.parse(calls[1]!.body!).extra_data).toBeUndefined();
  });

  it("reads Cloud node definitions from the bulk endpoint", async () => {
    const calls = mockFetch(() =>
      Response.json({ KSampler: { input: { required: {} } }, Other: { input: {} } }),
    );
    const info = await new ComfyClient({
      kind: "cloud",
      baseUrl: "https://cloud.comfy.org",
      apiKey: "k",
    }).objectInfo(["KSampler", "Missing"]);
    expect(Object.keys(info)).toEqual(["KSampler"]);
    expect(calls.map((c) => c.url)).toEqual(["https://cloud.comfy.org/api/object_info"]);
  });

  it("adds the account's model library to loader choices under either tag scheme", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/api/object_info"))
        return Response.json({
          CheckpointLoaderSimple: {
            input: { required: { ckpt_name: [["public.safetensors"], {}] } },
          },
          LoraLoader: { input: { required: { lora_name: [["lora-a.safetensors"], {}] } } },
        });
      if (url.endsWith("/api/features")) return new Response("nope", { status: 404 });
      const u = new URL(url);
      if (u.searchParams.get("after") === "c1")
        return Response.json({
          assets: [{ name: "second.safetensors", tags: ["models", "loras/style"] }],
          has_more: false,
        });
      return Response.json({
        assets: [
          {
            name: "0123abcd",
            tags: ["models", "model_type:checkpoints"],
            loader_path: "mine.safetensors",
            user_metadata: { filename: "mine.safetensors" },
          },
          // The loader path wins over a bare filename; legacy records only have `metadata`.
          {
            name: "0123abce",
            tags: ["models", "checkpoints"],
            loader_path: "sub/other.safetensors",
            user_metadata: { filename: "other.safetensors" },
          },
          {
            name: "0123abcf",
            tags: ["models", "checkpoints"],
            user_metadata: null,
            metadata: { filename: "legacy.safetensors" },
          },
          // A typed record without a loader path cannot be loaded: not offered.
          {
            name: "0123abd0",
            tags: ["models", "model_type:checkpoints"],
            loader_path: null,
            user_metadata: { filename: "orphan.safetensors" },
          },
          { name: "untagged.safetensors", tags: ["models"] },
        ],
        has_more: true,
        next_cursor: "c1",
      });
    });
    const info = await new ComfyClient({
      kind: "cloud",
      baseUrl: "https://cloud.comfy.org",
      apiKey: "k",
    }).objectInfo(["CheckpointLoaderSimple", "LoraLoader"]);
    expect(info.CheckpointLoaderSimple!.input!.required!.ckpt_name![0]).toEqual([
      "mine.safetensors",
      "sub/other.safetensors",
      "legacy.safetensors",
      "public.safetensors",
    ]);
    expect(info.LoraLoader!.input!.required!.lora_name![0]).toEqual([
      "second.safetensors",
      "lora-a.safetensors",
    ]);
    // One walk over the account's models, paged by cursor.
    const assetCalls = calls.filter((c) => c.url.includes("/api/assets"));
    expect(assetCalls).toHaveLength(2);
    const q = new URL(assetCalls[0]!.url).searchParams;
    expect(q.get("include_tags")).toBe("models");
    expect(q.get("exclude_tags")).toBe("missing");
    expect(q.get("include_public")).toBe("false");
    expect(new URL(assetCalls[1]!.url).searchParams.get("after")).toBe("c1");
    expect(assetCalls.every((c) => c.headers["X-API-Key"] === "k")).toBe(true);
  });

  it("offers only assets with a loader path when the server declares the model_type scheme", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/object_info"))
        return Response.json({ VAELoader: { input: { required: { vae_name: [[], {}] } } } });
      if (url.endsWith("/api/features")) return Response.json({ supports_model_type_tags: true });
      return Response.json({
        assets: [
          { name: "a", tags: ["models", "model_type:vae"], loader_path: "ae.safetensors" },
          // Not migrated yet: bare tag, no loader path. The server cannot load it.
          { name: "b", tags: ["models", "vae"], user_metadata: { filename: "old.safetensors" } },
        ],
        has_more: false,
      });
    });
    const info = await new ComfyClient({
      kind: "cloud",
      baseUrl: "https://cloud.comfy.org",
      apiKey: "k",
    }).objectInfo(["VAELoader"]);
    expect(info.VAELoader!.input!.required!.vae_name![0]).toEqual(["ae.safetensors"]);
  });

  it("keeps the node definitions when the model library cannot be read", async () => {
    const calls = mockFetch((url) =>
      url.endsWith("/api/object_info")
        ? Response.json({
            LoraLoader: { input: { required: { lora_name: [["lora-a.safetensors"], {}] } } },
            KSampler: { input: { required: {} } },
          })
        : new Response("disabled", { status: 503 }),
    );
    const cloud = new ComfyClient({
      kind: "cloud",
      baseUrl: "https://cloud.comfy.org",
      apiKey: "k",
    });
    const info = await cloud.objectInfo(["LoraLoader"]);
    expect(info.LoraLoader!.input!.required!.lora_name![0]).toEqual(["lora-a.safetensors"]);
    // A graph without model loaders never touches the library.
    await cloud.objectInfo(["KSampler"]);
    expect(calls.filter((c) => c.url.includes("/api/assets"))).toHaveLength(1);
  });

  it("lists every node class from the bulk /object_info, with the Cloud model library merged", async () => {
    const calls = mockFetch(() =>
      Response.json({
        KSampler: { input: { required: {} }, output: ["LATENT"] },
        CheckpointLoaderSimple: {
          input: { required: { ckpt_name: [["public.safetensors"], {}] } },
        },
        junk: 3,
      }),
    );
    const local = await new ComfyClient({
      kind: "local",
      baseUrl: "http://gpu:8188",
      apiKey: null,
    }).listNodeClasses();
    expect(Object.keys(local).toSorted()).toEqual(["CheckpointLoaderSimple", "KSampler"]);
    expect(calls.map((c) => c.url)).toEqual(["http://gpu:8188/object_info"]);

    mockFetch((url) => {
      if (url.endsWith("/api/object_info"))
        return Response.json({
          CheckpointLoaderSimple: {
            input: { required: { ckpt_name: [["public.safetensors"], {}] } },
          },
        });
      if (url.endsWith("/api/features")) return new Response("nope", { status: 404 });
      return Response.json({
        assets: [
          {
            name: "mine",
            tags: ["models", "model_type:checkpoints"],
            loader_path: "mine.safetensors",
          },
        ],
        has_more: false,
      });
    });
    const cloud = await new ComfyClient({
      kind: "cloud",
      baseUrl: "https://cloud.comfy.org",
      apiKey: "k",
    }).listNodeClasses();
    expect(cloud.CheckpointLoaderSimple!.input!.required!.ckpt_name![0]).toEqual([
      "mine.safetensors",
      "public.safetensors",
    ]);
    // Loader classes the server lacks get a minimal definition from the library, as in objectInfo.
    expect(cloud.LoraLoader).toBeUndefined();
  });

  it("follows Cloud job status, then lists outputs from history_v2", async () => {
    mockFetch(() => Response.json({ status: "executing" }));
    expect(await cloudClient().result("j1")).toEqual({ state: "pending" });

    mockFetch(() => Response.json({ status: "error", error_message: "GPU lost" }));
    expect(await cloudClient().result("j1")).toEqual({ state: "failed", error: "GPU lost" });

    mockFetch(() => Response.json({ status: "cancelled" }));
    expect(await cloudClient().result("j1")).toEqual({ state: "interrupted" });

    const calls = mockFetch((url) =>
      url.endsWith("/status")
        ? Response.json({ status: "success" })
        : Response.json({
            history: [
              {
                prompt_id: "j1",
                outputs: {
                  "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
                },
              },
            ],
          }),
    );
    expect(await cloudClient().result("j1")).toEqual({
      state: "succeeded",
      files: [{ nodeId: "9", filename: "a.png", subfolder: "", type: "output" }],
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://cloud.comfy.org/api/job/j1/status",
      "https://cloud.comfy.org/api/history_v2/j1",
    ]);
  });

  it("follows /view redirects without sending the key to another origin", async () => {
    const calls = mockFetch((url) =>
      url.startsWith("https://cloud.comfy.org")
        ? new Response(null, { status: 302, headers: { location: "https://storage.example/x" } })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    const client = new ComfyClient({
      kind: "cloud",
      baseUrl: "https://cloud.comfy.org",
      apiKey: "cloud-key",
    });
    const out = await client.view({ filename: "a.png", subfolder: "", type: "output" });
    expect(Array.from(new Uint8Array(await new Response(out.body).arrayBuffer()))).toEqual([
      1, 2, 3,
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/api/view?filename=a.png");
    expect(calls[1]!.url).toBe("https://storage.example/x");
    expect(calls[1]!.headers["X-API-Key"]).toBeUndefined();
  });

  it("fails the output stream once it exceeds the size cap", async () => {
    // Content-Length is absent, so only the streamed byte count can catch it.
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 65; i++) c.enqueue(new Uint8Array(8 * 1024 * 1024));
        c.close();
      },
    });
    mockFetch(() => new Response(big));
    const client = new ComfyClient({ kind: "local", baseUrl: "http://gpu:8188", apiKey: null });
    const out = await client.view({ filename: "v.mp4", subfolder: "", type: "output" });
    await expect(new Response(out.body).arrayBuffer()).rejects.toThrow("너무 큽니다");
  });

  it("turns auth failures and node errors into readable ComfyErrors", async () => {
    mockFetch(() => new Response("nope", { status: 401 }));
    const client = new ComfyClient({ kind: "local", baseUrl: "http://gpu:8188", apiKey: null });
    await expect(client.systemStats()).rejects.toThrow(/인증/);

    mockFetch(() =>
      Response.json(
        {
          error: { message: "Prompt outputs failed validation" },
          node_errors: {
            "4": { class_type: "Loader", errors: [{ message: "Value not in list" }] },
          },
        },
        { status: 400 },
      ),
    );
    const err = await client.queuePrompt({}, "c1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyError);
    expect(err instanceof ComfyError ? err.message : null).toBe("노드 4 Loader: Value not in list");
  });

  it("reports an unreachable server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
      }),
    );
    const client = new ComfyClient({ kind: "local", baseUrl: "http://gpu:8188", apiKey: null });
    await expect(client.systemStats()).rejects.toThrow("연결할 수 없습니다 (ECONNREFUSED)");
  });

  it("lists recent runs from /history on local servers only", async () => {
    const calls = mockFetch(() =>
      Response.json({
        p1: {
          prompt: [
            7,
            "p1",
            { "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } } },
            {},
            ["9"],
          ],
          outputs: {},
          status: { status_str: "success", completed: true, messages: [] },
        },
      }),
    );
    const local = new ComfyClient({ kind: "local", baseUrl: "http://gpu:8188", apiKey: null });
    const runs = await local.listHistory!(25);
    expect(runs.map((r) => r.promptId)).toEqual(["p1"]);
    expect(calls[0]!.url).toBe("http://gpu:8188/history?max_items=25");
    const cloud = new ComfyClient({
      kind: "cloud",
      baseUrl: "https://cloud.comfy.org",
      apiKey: "k",
    });
    expect(cloud.listHistory).toBeUndefined();
  });

  it("lists models and reads safetensors metadata on local servers only", async () => {
    const calls = mockFetch((url) => {
      if (url.includes("/models/")) return Response.json(["a.safetensors", "sub/b.ckpt", 3]);
      if (url.includes("missing")) return new Response(null, { status: 404 });
      if (url.includes("empty")) return new Response("");
      if (url.includes("huge")) return new Response("{" + " ".repeat(2 * 1024 * 1024) + "}");
      return Response.json({ "modelspec.title": "T", n: 5, o: { x: 1 } });
    });
    const local = new ComfyClient({ kind: "local", baseUrl: "http://gpu:8188", apiKey: null });
    expect(await local.listModels!("loras")).toEqual(["a.safetensors", "sub/b.ckpt"]);
    expect(calls[0]!.url).toBe("http://gpu:8188/models/loras");
    expect(await local.modelMetadata!("loras", "sub/a.safetensors")).toEqual({
      "modelspec.title": "T",
    });
    expect(calls[1]!.url).toBe("http://gpu:8188/view_metadata/loras?filename=sub%2Fa.safetensors");
    expect(await local.modelMetadata!("loras", "missing.safetensors")).toBeNull();
    expect(await local.modelMetadata!("loras", "empty.safetensors")).toBeNull();
    expect(await local.modelMetadata!("loras", "huge.safetensors")).toBeNull();
    const cloud = new ComfyClient({ kind: "cloud", baseUrl: "https://c.example", apiKey: "k" });
    expect(cloud.listModels).toBeUndefined();
    expect(cloud.modelMetadata).toBeUndefined();
  });

  it("fails a model list that is missing or not an array", async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const local = new ComfyClient({ kind: "local", baseUrl: "http://gpu:8188", apiKey: null });
    await expect(local.listModels!("loras")).rejects.toBeInstanceOf(ComfyError);
    mockFetch(() => Response.json({ a: 1 }));
    await expect(local.listModels!("loras")).rejects.toBeInstanceOf(ComfyError);
  });
});
