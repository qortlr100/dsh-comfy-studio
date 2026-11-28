import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { FAKE_MODEL, FAKE_PROVIDER, startFakeLlm } from "./llm.ts";
import type { FakeLlm, FakeReply, FakeScript } from "./llm.ts";

function post(baseURL: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function withLlm(script: FakeScript, run: (llm: FakeLlm) => Promise<void>): Promise<void> {
  const llm = await startFakeLlm(script);
  try {
    await run(llm);
  } finally {
    await llm.close();
  }
}

interface ToolCallDelta {
  index: number;
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface Frame {
  object: string;
  choices: { index: number; delta: Record<string, unknown>; finish_reason: string | null }[];
  usage?: Record<string, number>;
}

// Shallow checks: the chunks are this fake server's own output.
function isFrame(value: unknown): value is Frame {
  return (
    typeof value === "object" &&
    value !== null &&
    "object" in value &&
    "choices" in value &&
    Array.isArray(value.choices)
  );
}

function isToolCallList(value: unknown): value is ToolCallDelta[] {
  return Array.isArray(value);
}

async function readFrames(res: Response): Promise<{ frames: Frame[]; raw: string[] }> {
  const raw = (await res.text()).split("\n\n").filter((part) => part.length > 0);
  const frames: Frame[] = [];
  for (const part of raw) {
    expect(part.startsWith("data: ")).toBe(true);
    const data = part.slice("data: ".length);
    if (data === "[DONE]") continue;
    const parsed: unknown = JSON.parse(data);
    if (!isFrame(parsed)) throw new Error(`unexpected chunk: ${data}`);
    frames.push(parsed);
  }
  return { frames, raw };
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const streamBody = { model: FAKE_MODEL, stream: true, messages: [] };

test("streams reasoning, text and tool calls in order", async () => {
  const reply: FakeReply = {
    reasoning: "Let me  think about it.\n",
    text: "Hello there,  friend.",
    toolCalls: [
      { name: "alpha", arguments: { a: 1 } },
      { name: "beta", arguments: { b: "x" } },
    ],
  };
  await withLlm(
    () => reply,
    async (llm) => {
      const res = await post(llm.baseURL, streamBody);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const { frames, raw } = await readFrames(res);
      expect(raw.at(-1)).toBe("data: [DONE]");
      expect(frames.every((f) => f.object === "chat.completion.chunk")).toBe(true);

      const deltas = frames.slice(0, -2).map((f) => f.choices[0]?.delta ?? {});
      expect(deltas[0]).toEqual({ role: "assistant" });
      const kinds = deltas.slice(1).map((d) => Object.keys(d)[0]);
      const firstText = kinds.indexOf("content");
      const firstCall = kinds.indexOf("tool_calls");
      expect(kinds.slice(0, firstText).every((k) => k === "reasoning_content")).toBe(true);
      expect(kinds.slice(firstText, firstCall).every((k) => k === "content")).toBe(true);
      expect(kinds.slice(firstCall)).toEqual(["tool_calls", "tool_calls"]);

      const joined = (key: string): string =>
        deltas.map((d) => (typeof d[key] === "string" ? d[key] : "")).join("");
      expect(joined("reasoning_content")).toBe(reply.reasoning);
      expect(joined("content")).toBe(reply.text);

      const calls = deltas.slice(1 + firstCall).map((d) => {
        const list = d.tool_calls;
        if (!isToolCallList(list)) throw new Error("tool_calls is not a list");
        return list[0];
      });
      expect(calls.map((c) => [c?.index, c?.id, c?.type, c?.function.name])).toEqual([
        [0, "call_0_0", "function", "alpha"],
        [1, "call_0_1", "function", "beta"],
      ]);
      expect(JSON.parse(calls[0]?.function.arguments ?? "")).toEqual({ a: 1 });
      expect(JSON.parse(calls[1]?.function.arguments ?? "")).toEqual({ b: "x" });

      expect(frames.at(-2)?.choices).toEqual([
        { index: 0, delta: {}, finish_reason: "tool_calls" },
      ]);
      const usage = frames.at(-1);
      expect(usage?.choices).toEqual([]);
      expect(usage?.usage?.total_tokens).toBe(
        (usage?.usage?.prompt_tokens ?? 0) + (usage?.usage?.completion_tokens ?? 0),
      );
      await until(() => llm.requests[0]?.state === "done");
    },
  );
});

test("a text-only reply finishes with stop", async () => {
  await withLlm(
    () => ({ text: "ok" }),
    async (llm) => {
      const { frames } = await readFrames(await post(llm.baseURL, streamBody));
      expect(frames.at(-2)?.choices[0]?.finish_reason).toBe("stop");
    },
  );
});

test("records the request with flattened messages", async () => {
  await withLlm(
    () => ({ text: "ok" }),
    async (llm) => {
      const body = {
        model: FAKE_MODEL,
        stream: true,
        tools: [
          { type: "function", function: { name: "t1" } },
          { type: "function", function: { name: "t2" } },
        ],
        messages: [
          { role: "system", content: "rules" },
          {
            role: "user",
            content: [
              { type: "text", text: "one" },
              { type: "image_url", image_url: { url: "x" } },
              { type: "text", text: "two" },
            ],
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "t1", arguments: '{"k":1}' } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "result" },
        ],
      };
      await (await post(llm.baseURL, body)).text();
      const request = llm.requests[0];
      expect(request?.index).toBe(0);
      expect(request?.model).toBe(FAKE_MODEL);
      expect(request?.tools).toEqual(["t1", "t2"]);
      expect(request?.body).toEqual(body);
      expect(request?.messages).toEqual([
        { role: "system", text: "rules", toolCalls: [], toolCallId: undefined },
        { role: "user", text: "one\n[image_url]\ntwo", toolCalls: [], toolCallId: undefined },
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c1", name: "t1", arguments: '{"k":1}' }],
          toolCallId: undefined,
        },
        { role: "tool", text: "result", toolCalls: [], toolCallId: "c1" },
      ]);

      await (await post(llm.baseURL, streamBody)).text();
      expect(llm.requests[1]?.tools).toEqual([]);
    },
  );
});

test("a client hanging up mid-reply aborts the request", async () => {
  await withLlm(
    () => ({ text: "a b c d e f g h", chunkDelayMs: 50 }),
    async (llm) => {
      const controller = new AbortController();
      const res = await post(llm.baseURL, streamBody, controller.signal);
      expect(res.status).toBe(200);
      expect(llm.requests[0]?.state).toBe("open");
      controller.abort();
      await until(() => llm.requests[0]?.state === "aborted");

      const res2 = await post(llm.baseURL, streamBody);
      expect(res2.status).toBe(200);
      await res2.text();
      await until(() => llm.requests[1]?.state === "done");
      expect(llm.requests[0]?.state).toBe("aborted");
    },
  );
});

test("a throwing script answers 500 and fails the request", async () => {
  await withLlm(
    () => {
      throw new Error("boom");
    },
    async (llm) => {
      const res = await post(llm.baseURL, streamBody);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).toContain("boom");
      expect(llm.requests[0]?.state).toBe("failed");
    },
  );
});

test("non-stream requests, models and unknown paths", async () => {
  await withLlm(
    () => ({}),
    async (llm) => {
      const res = await post(llm.baseURL, { model: FAKE_MODEL, messages: [] });
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
      expect(llm.requests).toHaveLength(0);

      const models: unknown = await (await fetch(`${llm.baseURL}/models`)).json();
      expect(models).toMatchObject({ object: "list", data: [{ id: FAKE_MODEL, object: "model" }] });

      const missing = await fetch(`${llm.baseURL}/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toHaveProperty("error");
    },
  );
});

test("the patch file wires the server in and close() cleans up", async () => {
  const llm = await startFakeLlm(() => ({}));
  const patch: unknown = JSON.parse(readFileSync(llm.patch, "utf8"));
  expect(patch).toEqual([
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          [FAKE_PROVIDER]: {
            displayName: "Test model",
            api: "openai-completions",
            baseURL: llm.baseURL,
            headers: { Authorization: "Bearer cs-test" },
            models: [
              { id: FAKE_MODEL, name: "Test model", contextWindow: 262144, maxTokens: 16384 },
            ],
          },
        },
      },
    },
    { id: "agent-default-model", config: { provider: FAKE_PROVIDER, model: FAKE_MODEL } },
  ]);
  await llm.close();
  expect(existsSync(llm.patch)).toBe(false);
  await expect(fetch(`${llm.baseURL}/models`)).rejects.toThrow();
  await llm.close();
});
