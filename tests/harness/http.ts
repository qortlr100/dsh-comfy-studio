// Small network helpers of the test harness: a free loopback port and a raw HTTP request that
// can carry any Host header, which `fetch` forbids.

import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";

/** A loopback port nobody listens on right now. Another process could still take it. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") reject(new Error("No port."));
        else resolve(address.port);
      });
    });
  });
}

export interface RawTarget {
  host: string;
  port: number;
}

export interface RawOptions {
  /** Sent as the Host header; the target's own authority when absent. */
  host?: string;
  /** Further request headers. */
  headers?: Readonly<Record<string, string>>;
  method?: string;
}

export interface RawAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One request with a fresh connection; the whole body is read. */
export function rawRequest(
  target: RawTarget,
  path: string,
  options: RawOptions = {},
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.host !== undefined) headers.host = options.host;
    const req = request(
      {
        host: target.host,
        port: target.port,
        path,
        method: options.method ?? "GET",
        headers,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
