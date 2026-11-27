import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ProjectEvent, ProjectId } from "@cs/project";
import { defined, standIn } from "@cs/project/testing/support";
import { EVENTS_PATH, ROUTES } from "./index.ts";
import {
  frameOf,
  MAX_BUFFERED_BYTES,
  serveEventStream,
  type EventStreamSources,
} from "./events.ts";
import { asRecord, mountApi } from "./testing/support.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * Serve a handler on a real HTTP server on an ephemeral port; the server closes when the test ends.
 * @param handler - the request handler.
 * @returns the base URL.
 */
async function serve(handler: Handler): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The server has no port.");
  return `http://127.0.0.1:${String(address.port)}`;
}

/** An open event stream: the response and the text received so far. */
interface OpenStream {
  response: Response;
  /** Read until the text received so far contains `needle`; returns all of it. */
  until(needle: string): Promise<string>;
  /** Close the connection from the client side. */
  close(): void;
}

/**
 * Open a stream with `fetch` and read it chunk by chunk.
 * @param url - the URL.
 * @param init - extra fetch options.
 * @returns the open stream.
 */
async function open(url: string, init: RequestInit = {}): Promise<OpenStream> {
  const controller = new AbortController();
  onTestFinished(() => {
    controller.abort();
  });
  const response = await fetch(url, { ...init, signal: controller.signal });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    response,
    async until(needle) {
      while (!text.includes(needle)) {
        const chunk = await defined(reader, "a response body").read();
        if (chunk.done)
          throw new Error(`The stream ended before ${JSON.stringify(needle)}: ${text}`);
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    },
    close: () => {
      controller.abort();
    },
  };
}

/** Event sources that count subscriptions. */
class FakeSources implements EventStreamSources {
  readonly listeners = new Set<(event: ProjectEvent) => void>();
  unsubscribed = 0;
  readonly keepaliveMs: number;

  constructor(keepaliveMs = 60_000) {
    this.keepaliveMs = keepaliveMs;
  }

  subscribe(_project: ProjectId, listener: (event: ProjectEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.unsubscribed += 1;
    };
  }

  emit(event: ProjectEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const PROJECT = standIn<ProjectId>("p1");

describe("frameOf", () => {
  it("names the event by its kind and carries the event as JSON data", () => {
    const line = standIn<ProjectEvent>({ kind: "line", tip: "r2", at: "r1" });
    expect(frameOf(line)).toBe(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
    const record = standIn<ProjectEvent>({ kind: "update", record: { id: "r1", status: "done" } });
    expect(frameOf(record).startsWith("event: update\ndata: {")).toBe(true);
    expect(frameOf(record).endsWith("\n\n")).toBe(true);
  });
});

describe("serveEventStream", () => {
  it("answers event-stream headers, then a comment and the ready event", async () => {
    const sources = new FakeSources();
    const url = await serve((request, response) => {
      serveEventStream(PROJECT, request, response, sources);
    });
    const stream = await open(url);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(stream.response.headers.get("cache-control")).toBe("no-store, no-transform");
    const text = await stream.until("event: ready\ndata: {}\n\n");
    expect(text.startsWith(": connected p1\n\n")).toBe(true);
    expect(sources.listeners.size).toBe(1);
  });

  it("writes each project event as a frame in order", async () => {
    const sources = new FakeSources();
    const url = await serve((request, response) => {
      serveEventStream(PROJECT, request, response, sources);
    });
    const stream = await open(url);
    await stream.until("event: ready");
    const line = standIn<ProjectEvent>({ kind: "line", tip: "r2", at: "r2" });
    const update = standIn<ProjectEvent>({ kind: "update", record: { id: "r2" } });
    sources.emit(update);
    sources.emit(line);
    const text = await stream.until(frameOf(line));
    expect(text.endsWith(frameOf(update) + frameOf(line))).toBe(true);
  });

  it("unsubscribes when the client closes the request", async () => {
    const sources = new FakeSources();
    const url = await serve((request, response) => {
      serveEventStream(PROJECT, request, response, sources);
    });
    const stream = await open(url);
    await stream.until("event: ready");
    expect(sources.listeners.size).toBe(1);
    stream.close();
    await vi.waitFor(() => {
      expect(sources.unsubscribed).toBe(1);
    });
    expect(sources.listeners.size).toBe(0);
  });

  it("sends keep-alive comments on the interval", async () => {
    const sources = new FakeSources(15);
    const url = await serve((request, response) => {
      serveEventStream(PROJECT, request, response, sources);
    });
    const stream = await open(url);
    await stream.until(": keepalive\n\n");
  });

  it("streams a real project's record, update and line events after a run", async () => {
    const f = await mountApi();
    const project = await f.newProject();
    const url = await serve((request, response) => {
      serveEventStream(project, request, response, {
        subscribe: (id, listener) => f.project.subscribe(id, listener),
        keepaliveMs: 60_000,
      });
    });
    const stream = await open(url);
    await stream.until("event: ready");
    const record = await f.api.runOperation({
      project,
      operation: "probe_note.add",
      params: { text: "hi" },
    });
    const text = await stream.until(
      `event: update\ndata: {"kind":"update","record":{"id":"${record.id}"`,
    );
    const kinds = [...text.matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);
    expect(kinds[0]).toBe("ready");
    expect(kinds).toContain("record");
    expect(kinds).toContain("line");
    expect(kinds.indexOf("record")).toBeLessThan(kinds.lastIndexOf("update"));
    const lineFrame = defined(text.match(/event: line\ndata: (.*)\n/)?.[1]);
    expect(asRecord(JSON.parse(lineFrame))).toMatchObject({
      kind: "line",
      at: record.id,
      tip: record.id,
    });
  });
});

/** The stand-in services `CsApi` reads. */
interface StandIns {
  admit: ReturnType<typeof vi.fn>;
  fetchRoutes: Array<{ path: string; methods: readonly string[] }>;
  webRoutes: Array<{ kind: string; path: string; handler: Handler }>;
}

/**
 * Provide stand-in `connection` and `webServer` services on a context.
 * @param ctx - the context.
 * @param which - the services to provide.
 * @param standIns - where the stand-ins record what is registered.
 */
function provideServices(
  ctx: Context,
  which: Array<"connection" | "webServer">,
  standIns: StandIns,
): void {
  if (which.includes("connection")) {
    ctx.provide(
      "connection",
      standIn({
        admit: standIns.admit,
        fetch: {
          register: (route: { path: string; methods: readonly string[] }) => {
            standIns.fetchRoutes.push(route);
            return () => Promise.resolve();
          },
        },
      }),
    );
  }
  if (which.includes("webServer")) {
    ctx.provide(
      "webServer",
      standIn({
        register: (route: { kind: string; path: string; handler: Handler }) => {
          standIns.webRoutes.push(route);
          return () => undefined;
        },
      }),
    );
  }
}

/** @returns an empty record of stand-in registrations. */
function newStandIns(): StandIns {
  return { admit: vi.fn(), fetchRoutes: [], webRoutes: [] };
}

/**
 * Mount the API with both stand-in services and serve the registered stream handler.
 * @returns the fixture, the stand-ins and the stream URL.
 */
async function mounted() {
  const standIns = newStandIns();
  const f = await mountApi((ctx) => {
    provideServices(ctx, ["connection", "webServer"], standIns);
  });
  const route = defined(standIns.webRoutes[0], "the stream route");
  const url = await serve(route.handler);
  return { f, standIns, url, route };
}

/** What Connection answers for the owner's browser. */
const owner = { peer: { principal: { kind: "owner" } } };

describe("the /cs/events route of CsApi", () => {
  it("registers an exact route at /cs/events and the Fetch routes through Connection", async () => {
    const { standIns, route } = await mounted();
    expect(standIns.webRoutes).toHaveLength(1);
    expect(route).toMatchObject({ kind: "exact", path: EVENTS_PATH });
    expect(standIns.fetchRoutes.map((r) => r.path).toSorted()).toEqual(
      Object.values(ROUTES).toSorted(),
    );
    expect(standIns.fetchRoutes.find((r) => r.path === ROUTES.projects)?.methods).toEqual([
      "GET",
      "POST",
    ]);
    expect(standIns.fetchRoutes.find((r) => r.path === ROUTES.state)?.methods).toEqual(["GET"]);
  });

  it("registers no stream route when there is no connection service", async () => {
    const standIns = newStandIns();
    await mountApi((ctx) => {
      provideServices(ctx, ["webServer"], standIns);
    });
    expect(standIns.webRoutes).toEqual([]);
    expect(standIns.fetchRoutes).toEqual([]);
  });

  it("registers the Fetch routes but no stream when there is no web server", async () => {
    const standIns = newStandIns();
    await mountApi((ctx) => {
      provideServices(ctx, ["connection"], standIns);
    });
    expect(standIns.webRoutes).toEqual([]);
    expect(standIns.fetchRoutes).toHaveLength(Object.keys(ROUTES).length);
  });

  it("answers 401 with the status Connection rejects with, passing it the request headers", async () => {
    const { standIns, url } = await mounted();
    standIns.admit.mockReturnValue({ rejection: 401 });
    const response = await fetch(`${url}${EVENTS_PATH}?project=x`, { headers: { cookie: "a=b" } });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(standIns.admit).toHaveBeenCalledWith({
      headers: expect.objectContaining({ cookie: "a=b" }),
    });
  });

  it("answers the rejection status 403 too", async () => {
    const { standIns, url } = await mounted();
    standIns.admit.mockReturnValue({ rejection: 403 });
    expect((await fetch(url)).status).toBe(403);
  });

  it("answers 403 for an admitted peer that is not the owner", async () => {
    const { f, standIns, url } = await mounted();
    const project = await f.newProject();
    standIns.admit.mockReturnValue({ peer: { principal: { kind: "api" } } });
    const response = await fetch(`${url}?project=${project}`);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });

  it("answers 400 invalid_params for a missing or malformed project", async () => {
    const { standIns, url } = await mounted();
    standIns.admit.mockReturnValue(owner);
    for (const query of ["", "?project=", "?project=bad%20id"]) {
      const response = await fetch(`${url}${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(asRecord(await response.json())["code"]).toBe("invalid_params");
    }
  });

  it("answers 404 unknown_project for a project that does not exist", async () => {
    const { standIns, url } = await mounted();
    standIns.admit.mockReturnValue(owner);
    const response = await fetch(`${url}?project=nothing`);
    expect(response.status).toBe(404);
    const body = asRecord(await response.json());
    expect(body["code"]).toBe("unknown_project");
    expect(typeof body["error"]).toBe("string");
  });

  it("answers 405 to a method other than GET", async () => {
    const { standIns, url } = await mounted();
    standIns.admit.mockReturnValue(owner);
    const response = await fetch(url, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(standIns.admit).not.toHaveBeenCalled();
  });

  it("opens the stream for an owner peer and a known project, and delivers events", async () => {
    const { f, standIns, url } = await mounted();
    const project = await f.newProject();
    standIns.admit.mockReturnValue(owner);
    const stream = await open(`${url}?project=${project}`);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
    await stream.until("event: ready");
    await f.api.runOperation({ project, operation: "probe_note.add", params: { text: "x" } });
    await stream.until("event: line");
  });
});

/** A response that records what is written and lets a test set how much is buffered. */
class FakeResponse extends EventEmitter {
  readonly written: string[] = [];
  writableLength = 0;
  ends = 0;

  writeHead(): this {
    return this;
  }

  write(text: string): boolean {
    this.written.push(text);
    return true;
  }

  end(): this {
    this.ends += 1;
    return this;
  }
}

describe("ending a stream", () => {
  it("returns a function that ends the stream once and tells the owner", () => {
    const sources = new FakeSources();
    let ended = 0;
    const response = new FakeResponse();
    const end = serveEventStream(PROJECT, standIn(new EventEmitter()), standIn(response), {
      subscribe: (project, listener) => sources.subscribe(project, listener),
      keepaliveMs: sources.keepaliveMs,
      onEnd: () => {
        ended += 1;
      },
    });
    expect(sources.listeners.size).toBe(1);
    end();
    end();
    response.emit("close");
    expect(response.ends).toBe(1);
    expect(ended).toBe(1);
    expect(sources.unsubscribed).toBe(1);
    // Nothing is written after the end.
    const before = response.written.length;
    sources.emit({ kind: "line", tip: standIn("r2"), at: standIn("r1") });
    expect(response.written).toHaveLength(before);
  });

  it("ends a stream whose client stopped reading instead of buffering without bound", () => {
    const sources = new FakeSources();
    const response = new FakeResponse();
    serveEventStream(PROJECT, standIn(new EventEmitter()), standIn(response), sources);
    sources.emit({ kind: "line", tip: standIn("r1"), at: standIn("r1") });
    expect(response.ends).toBe(0);
    response.writableLength = MAX_BUFFERED_BYTES + 1;
    sources.emit({ kind: "line", tip: standIn("r2"), at: standIn("r2") });
    expect(response.ends).toBe(1);
    expect(sources.unsubscribed).toBe(1);
  });

  it("does not subscribe when the stream ends while its first lines are written", () => {
    const sources = new FakeSources();
    const response = new FakeResponse();
    response.writableLength = MAX_BUFFERED_BYTES + 1;
    serveEventStream(PROJECT, standIn(new EventEmitter()), standIn(response), sources);
    expect(response.ends).toBe(1);
    expect(sources.listeners.size).toBe(0);
  });

  it("ends every open stream when the plugin goes away, so the browser connects again", async () => {
    const { f, standIns, url } = await mounted();
    const project = await f.newProject();
    standIns.admit.mockReturnValue(owner);
    const first = await open(`${url}?project=${project}`);
    const second = await open(`${url}?project=${project}`);
    await first.until("event: ready");
    await second.until("event: ready");
    await f.context.fiber.dispose();
    await expect(first.until("event: never")).rejects.toThrow(/stream ended/);
    await expect(second.until("event: never")).rejects.toThrow(/stream ended/);
  });
});
