// A reverse proxy for tests, plain Node without dependencies. It stands in for what runs in
// front of dsh in a deployment: it forwards HTTP with streamed bodies and responses (nothing is
// buffered, or the event stream would stall) and WebSocket upgrades, keeps the browser's Host
// header unless told to rewrite it, and can ask for Basic auth. Every request it forwards is
// recorded for assertions. Findings it was built on: docs/archive/PLAN_1-5.md.

import { request as httpRequest, createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

export interface ProxyOptions {
  /** The server behind the proxy. */
  upstream: { host: string; port: number };
  /** Default true: the upstream gets the browser's Host. false sends the upstream's own. */
  preserveHost?: boolean;
  /** `user:password`: everything else gets 401 with a challenge. */
  basicAuth?: string;
  /** Fixed listening port on 127.0.0.1; default a free one. */
  port?: number;
}

/** One request the proxy let through. */
export interface SeenRequest {
  method: string;
  path: string;
  /** The Host header the upstream was sent. */
  host: string;
  /** True for a WebSocket upgrade. */
  upgrade: boolean;
}

export interface TestProxy {
  readonly port: number;
  /** Requests forwarded so far, in order; refused ones (401) are not listed. */
  readonly seen: readonly SeenRequest[];
  /** Number of WebSocket upgrades forwarded. */
  readonly upgrades: number;
  /** Stops listening and destroys every open connection, upgraded ones included. */
  close(): Promise<void>;
}

const CHALLENGE = 'Basic realm="proxy"';

function hostOf(headers: IncomingHttpHeaders): string {
  return headers.host ?? "";
}

/** Starts a proxy on 127.0.0.1 and resolves once it listens. */
export async function startProxy(options: ProxyOptions): Promise<TestProxy> {
  const seen: SeenRequest[] = [];
  const sockets = new Set<Duplex>();
  const preserveHost = options.preserveHost ?? true;
  const upstreamAuthority = `${options.upstream.host}:${options.upstream.port}`;
  const expectedAuth =
    options.basicAuth === undefined
      ? undefined
      : `Basic ${Buffer.from(options.basicAuth).toString("base64")}`;

  const authorized = (req: IncomingMessage): boolean =>
    expectedAuth === undefined || req.headers.authorization === expectedAuth;

  const headersFor = (req: IncomingMessage): IncomingHttpHeaders => {
    const headers: IncomingHttpHeaders = { ...req.headers };
    if (!preserveHost) headers.host = upstreamAuthority;
    return headers;
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!authorized(req)) {
      res.writeHead(401, { "www-authenticate": CHALLENGE, "content-length": 0 });
      res.end();
      return;
    }
    const headers = headersFor(req);
    // One connection per request, so no idle keep-alive socket outlives close().
    delete headers.connection;
    seen.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      host: hostOf(headers),
      upgrade: false,
    });
    const upstream = httpRequest(
      {
        host: options.upstream.host,
        port: options.upstream.port,
        method: req.method,
        path: req.url,
        headers,
        agent: false,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.on("data", (chunk: Buffer) => {
          res.write(chunk);
        });
        answer.on("end", () => res.end());
        answer.on("error", () => res.destroy());
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  };

  const server = createServer(handle);

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!authorized(req)) {
      socket.end(
        `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${CHALLENGE}\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    const headers = headersFor(req);
    seen.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      host: hostOf(headers),
      upgrade: true,
    });
    const back = connect(options.upstream.port, options.upstream.host, () => {
      let text = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const one of Array.isArray(value) ? value : [value]) text += `${name}: ${one}\r\n`;
      }
      back.write(`${text}\r\n`);
      if (head.length > 0) back.write(head);
      socket.pipe(back);
      back.pipe(socket);
    });
    // Upgraded sockets are no longer the server's: they are closed here.
    sockets.add(socket);
    sockets.add(back);
    const drop = (): void => {
      socket.destroy();
      back.destroy();
      sockets.delete(socket);
      sockets.delete(back);
    };
    back.on("error", drop);
    socket.on("error", drop);
    back.on("close", drop);
    socket.on("close", drop);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The proxy has no port.");

  return {
    port: address.port,
    seen,
    get upgrades() {
      return seen.filter((entry) => entry.upgrade).length;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
