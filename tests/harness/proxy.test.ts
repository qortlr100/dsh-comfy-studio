// The test proxy against a plain Node upstream: streaming, Host handling, Basic auth and
// WebSocket upgrades, so the integration tests behind it can trust what it reports.

import { createServer, request } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { rawRequest } from "./http.ts";
import { startProxy } from "./proxy.ts";
import type { ProxyOptions, TestProxy } from "./proxy.ts";

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop();
});

/** An upstream that echoes the Host it saw and streams on `/stream`; kept open until `go()`. */
async function startUpstream(): Promise<{ port: number; go: () => void; upgrades: string[] }> {
  const upgrades: string[] = [];
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  const server: Server = createServer((req: IncomingMessage, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first\n");
      void gate.then(() => res.end("second\n"));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`host=${req.headers.host ?? ""}`);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req: IncomingMessage, socket) => {
    upgrades.push(`${req.headers.upgrade ?? ""}|${req.headers.host ?? ""}`);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.write("hello-from-upstream");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stops.push(
    () =>
      new Promise<void>((resolve) => {
        release();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No upstream port.");
  return { port: address.port, go: release, upgrades };
}

async function proxyTo(
  upstreamPort: number,
  options: Omit<ProxyOptions, "upstream"> = {},
): Promise<TestProxy> {
  const proxy = await startProxy({
    upstream: { host: "127.0.0.1", port: upstreamPort },
    ...options,
  });
  stops.push(() => proxy.close());
  return proxy;
}

test("a streamed response reaches the client chunk by chunk, before the upstream ends it", async () => {
  const upstream = await startUpstream();
  const proxy = await proxyTo(upstream.port);

  const firstChunk = await new Promise<string>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: proxy.port, path: "/stream", agent: false },
      (res) => {
        res.setEncoding("utf8");
        res.once("data", (chunk: string) => {
          // The upstream is still holding the rest back.
          upstream.go();
          resolve(chunk);
          res.resume();
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
  expect(firstChunk).toBe("first\n");
});

test("the browser's Host is kept by default and rewritten to the upstream's on request", async () => {
  const upstream = await startUpstream();
  const keeping = await proxyTo(upstream.port);
  const rewriting = await proxyTo(upstream.port, { preserveHost: false });

  const kept = await rawRequest({ host: "127.0.0.1", port: keeping.port }, "/", {
    host: "studio.example.test:1234",
  });
  expect(kept.body).toBe("host=studio.example.test:1234");
  expect(keeping.seen).toEqual([
    { method: "GET", path: "/", host: "studio.example.test:1234", upgrade: false },
  ]);

  const rewritten = await rawRequest({ host: "127.0.0.1", port: rewriting.port }, "/", {
    host: "studio.example.test:1234",
  });
  expect(rewritten.body).toBe(`host=127.0.0.1:${upstream.port}`);
});

test("Basic auth answers 401 with a challenge until the credentials are sent", async () => {
  const upstream = await startUpstream();
  const proxy = await proxyTo(upstream.port, { basicAuth: "user:secret" });
  const target = { host: "127.0.0.1", port: proxy.port };

  const refused = await rawRequest(target, "/");
  expect(refused.status).toBe(401);
  expect(refused.headers["www-authenticate"]).toContain("Basic");
  const wrong = await rawRequest(target, "/", {
    headers: { authorization: `Basic ${Buffer.from("user:nope").toString("base64")}` },
  });
  expect(wrong.status).toBe(401);
  expect(proxy.seen).toEqual([]);

  const passed = await rawRequest(target, "/", {
    headers: { authorization: `Basic ${Buffer.from("user:secret").toString("base64")}` },
  });
  expect(passed.status).toBe(200);
  expect(proxy.seen).toHaveLength(1);
});

test("a WebSocket upgrade is forwarded and the connection carries data both ways", async () => {
  const upstream = await startUpstream();
  const proxy = await proxyTo(upstream.port);

  const received = await new Promise<string>((resolve, reject) => {
    const socket = connect(proxy.port, "127.0.0.1", () => {
      socket.write(
        "GET /socket HTTP/1.1\r\nHost: studio.example.test\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("hello-from-upstream")) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on("error", reject);
  });
  expect(received).toContain("101 Switching Protocols");
  expect(upstream.upgrades).toEqual(["test|studio.example.test"]);
  expect(proxy.upgrades).toBe(1);
});
