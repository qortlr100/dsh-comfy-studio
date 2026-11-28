// A fake LLM server that imitates the OpenAI Chat Completions streaming API, driven by a script
// function the test supplies. Spec: docs/archive/PLAN_1-3.md "`tests/harness/llm.ts` — 가짜 LLM 서버"
// ("틀의 명세"). Node built-ins and `./dsh.ts` only; erasable syntax only.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempParent } from "./dsh.ts";

/** One reply, streamed in this order: reasoning, text, tool calls. */
export interface FakeReply {
  reasoning?: string;
  text?: string;
  toolCalls?: readonly { name: string; arguments: Readonly<Record<string, unknown>> }[];
  /** Wait before the first chunk. Default 0. */
  delayMs?: number;
  /** Wait between two chunks. Default 0. */
  chunkDelayMs?: number;
}

export interface FakeMessage {
  role: string;
  /** Text parts joined with "\n"; a part that is not text shows as `[<type>]`. */
  text: string;
  /** The assistant's tool calls. */
  toolCalls: readonly { id: string; name: string; arguments: string }[];
  /** On a `tool` message: the call it answers. */
  toolCallId: string | undefined;
}

export interface FakeRequest {
  /** Position among the chat requests, from 0. */
  readonly index: number;
  readonly model: string;
  /** Names of the offered tools; empty when none were sent (dsh's session-title request). */
  readonly tools: readonly string[];
  readonly messages: readonly FakeMessage[];
  /** The parsed body as it came. */
  readonly body: unknown;
  /** `open` while the reply is on its way, `aborted` when the client hung up first. */
  readonly state: "open" | "done" | "aborted" | "failed";
}

export type FakeScript = (request: FakeRequest) => FakeReply;

export interface FakeLlm {
  /** `http://127.0.0.1:<port>/v1` */
  readonly baseURL: string;
  /** Chat requests so far, oldest first. The array is live: poll it. */
  readonly requests: readonly FakeRequest[];
  /** A `--patch` file that makes this server the default model of the dsh it is given to. */
  readonly patch: string;
  /** Stops the server, ends open replies and deletes the patch file. Safe to call twice. */
  close(): Promise<void>;
}

export const FAKE_PROVIDER = "cs-test-llm";
export const FAKE_MODEL = "cs-test-model";

interface MutableRequest {
  index: number;
  model: string;
  tools: string[];
  messages: FakeMessage[];
  body: unknown;
  state: FakeRequest["state"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    parts.push(part.type === "text" ? str(part.text) : `[${str(part.type)}]`);
  }
  return parts.join("\n");
}

function flattenMessage(raw: unknown): FakeMessage {
  const message = isRecord(raw) ? raw : {};
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call.function) ? call.function : {};
      toolCalls.push({ id: str(call.id), name: str(fn.name), arguments: str(fn.arguments) });
    }
  }
  return {
    role: str(message.role),
    text: flattenContent(message.content),
    toolCalls,
    toolCallId: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
  };
}

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return [];
  const names: string[] = [];
  for (const tool of body.tools) {
    if (isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string") {
      names.push(tool.function.name);
    }
  }
  return names;
}

/** Splits into word-sized pieces; joining the pieces gives the string back. */
function pieces(text: string): string[] {
  return text.match(/\s*\S+\s*|\s+/g) ?? [];
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function buildChunks(reply: FakeReply, requestIndex: number): string[] {
  const id = `chatcmpl-cs-${requestIndex}`;
  const created = Math.floor(Date.now() / 1000);
  const frame = (choices: unknown[], extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: FAKE_MODEL,
      choices,
      ...extra,
    })}\n\n`;
  const delta = (value: Record<string, unknown>, finish: string | null = null): string =>
    frame([{ index: 0, delta: value, finish_reason: finish }]);

  const out: string[] = [delta({ role: "assistant" })];
  for (const piece of pieces(reply.reasoning ?? "")) out.push(delta({ reasoning_content: piece }));
  for (const piece of pieces(reply.text ?? "")) out.push(delta({ content: piece }));
  const calls = reply.toolCalls ?? [];
  calls.forEach((call, n) => {
    out.push(
      delta({
        tool_calls: [
          {
            index: n,
            id: `call_${requestIndex}_${n}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          },
        ],
      }),
    );
  });
  out.push(delta({}, calls.length > 0 ? "tool_calls" : "stop"));
  out.push(frame([], { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  out.push("data: [DONE]\n\n");
  return out;
}

export async function startFakeLlm(script: FakeScript): Promise<FakeLlm> {
  const requests: MutableRequest[] = [];
  /** Replies on their way, each with a way to stop its pending timer. */
  const inFlight = new Set<{ res: ServerResponse; cancel: () => void }>();

  function stream(res: ServerResponse, record: MutableRequest, reply: FakeReply): void {
    const chunks = buildChunks(reply, record.index);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let timer: NodeJS.Timeout | undefined;
    const entry = {
      res,
      cancel: () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      },
    };
    inFlight.add(entry);
    res.on("close", () => {
      entry.cancel();
      inFlight.delete(entry);
      if (record.state === "open" && !res.writableFinished) record.state = "aborted";
    });

    let next = 0;
    const schedule = (ms: number): void => {
      timer = setTimeout(step, ms);
    };
    function step(): void {
      timer = undefined;
      if (res.destroyed || res.writableEnded) return;
      const chunk = chunks[next++];
      if (chunk === undefined) return;
      res.write(chunk);
      if (next < chunks.length) {
        schedule(reply.chunkDelayMs ?? 0);
      } else {
        record.state = "done";
        res.end();
      }
    }
    schedule(reply.delayMs ?? 0);
  }

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
      return;
    }
    if (!isRecord(body) || body.stream !== true) {
      json(res, 400, {
        error: { message: "only stream: true is supported", type: "invalid_request_error" },
      });
      return;
    }
    const record: MutableRequest = {
      index: requests.length,
      model: str(body.model),
      tools: toolNames(body),
      messages: Array.isArray(body.messages) ? body.messages.map(flattenMessage) : [],
      body,
      state: "open",
    };
    requests.push(record);
    let reply: FakeReply;
    try {
      reply = script(record);
    } catch (error) {
      record.state = "failed";
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: { message, type: "script_error" } });
      return;
    }
    stream(res, record, reply);
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      void chat(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          json(res, 500, { error: { message: String(error), type: "server_error" } });
        } else {
          res.destroy();
        }
      });
    } else if (req.method === "GET" && url.pathname === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: [{ id: FAKE_MODEL, object: "model", created: 0, owned_by: "cs-test" }],
      });
    } else {
      json(res, 404, { error: { message: `not found: ${url.pathname}`, type: "not_found" } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  const folder = mkdtempSync(join(tempParent(), "cs-dsh-test-llm-"));
  const patch = join(folder, "llm.patch.yml");
  writeFileSync(
    patch,
    JSON.stringify(
      [
        {
          id: "llm-pi-ai",
          config: {
            providers: {
              [FAKE_PROVIDER]: {
                displayName: "Test model",
                api: "openai-completions",
                baseURL,
                // The fake server checks no credentials, but dsh's OpenAI-compatible client
                // sends nothing without a key or this header. A placeholder, not a secret.
                headers: { Authorization: "Bearer cs-test" },
                models: [
                  { id: FAKE_MODEL, name: "Test model", contextWindow: 262144, maxTokens: 16384 },
                ],
              },
            },
          },
        },
        { id: "agent-default-model", config: { provider: FAKE_PROVIDER, model: FAKE_MODEL } },
      ],
      null,
      2,
    ),
  );

  let closing: Promise<void> | undefined;
  return {
    baseURL,
    requests,
    patch,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const entry of inFlight) {
          entry.cancel();
          entry.res.end();
        }
        server.close(() => resolve());
        server.closeAllConnections();
      }).finally(() => {
        rmSync(folder, { recursive: true, force: true });
      });
      return closing;
    },
  };
}
