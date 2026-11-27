import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { standIn } from "../testing/support.ts";
import { parseListXml, VolumeClient, VolumeError } from "./volume.ts";

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
}

/** Just enough S3 for the volume client: objects by path, HEAD, DELETE, PUT and ListObjectsV2. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const seen: Seen[] = [];
  let failNext: number | null = null;
  let pageSize: number | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const p = decodeURIComponent(url.pathname);
      seen.push({ method: req.method!, path: p, query: url.searchParams, headers: req.headers });
      if (failNext) {
        res.writeHead(failNext, { "content-type": "application/xml" });
        res.end("<Error><Code>AccessDenied</Code><Message>no</Message></Error>");
        failNext = null;
        return;
      }
      const body = Buffer.concat(chunks);
      if (req.method === "GET" && url.searchParams.get("list-type") === "2" && p === "/vol") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter");
        const max = Math.min(Number(url.searchParams.get("max-keys") ?? 1000), pageSize ?? 1000);
        const start = url.searchParams.get("continuation-token");
        let keys = [...objects.keys()]
          .map((k) => k.replace(/^\/vol\//, ""))
          .filter((k) => k.startsWith(prefix))
          .toSorted();
        if (delimiter) keys = keys.filter((k) => !k.slice(prefix.length).includes(delimiter));
        if (start) keys = keys.filter((k) => k > start);
        const page = keys.slice(0, max);
        const truncated = keys.length > max;
        const xml =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          page
            .map(
              (k) =>
                `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key>` +
                `<LastModified>2026-10-22T01:02:03.000Z</LastModified>` +
                `<Size>${objects.get(`/vol/${k}`)!.length}</Size></Contents>`,
            )
            .join("") +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : "") +
          `</ListBucketResult>`;
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(xml);
        return;
      }
      const obj = objects.get(p);
      switch (req.method) {
        case "PUT":
          objects.set(p, body);
          res.writeHead(200, { etag: '"put"' }).end();
          return;
        case "HEAD":
          if (!obj) res.writeHead(404).end();
          else
            res
              .writeHead(200, {
                "content-length": obj.length,
                etag: '"abc"',
                "content-type": "application/json",
              })
              .end();
          return;
        case "DELETE":
          objects.delete(p);
          res.writeHead(204).end();
          return;
        case "GET":
          if (!obj) {
            res.writeHead(404, { "content-type": "application/xml" });
            res.end("<Error><Code>NoSuchKey</Code></Error>");
            return;
          }
          res.writeHead(200, { "content-length": obj.length, "content-type": "image/png" });
          res.end(obj);
          return;
        default:
          res.writeHead(405).end();
      }
    });
  });
  return {
    server,
    objects,
    seen,
    failNext: (status: number) => (failNext = status),
    setPageSize: (n: number | null) => (pageSize = n),
  };
}

const s3 = fakeS3();
let client: VolumeClient;

beforeAll(async () => {
  await new Promise<void>((r) => s3.server.listen(0, "127.0.0.1", r));
  const { port } = standIn<AddressInfo>(s3.server.address());
  client = new VolumeClient({
    endpoint: `http://127.0.0.1:${port}`,
    region: "EU-RO-1",
    bucket: "vol",
    accessKeyId: "user_abc",
    secretAccessKey: "rps_secret",
  });
});
afterAll(() => new Promise<void>((r) => s3.server.close(() => r())));
beforeEach(() => {
  s3.objects.clear();
  s3.seen.length = 0;
});

describe("VolumeClient", () => {
  it("addresses objects path-style under the volume id and signs with the datacenter region", async () => {
    await client.put("input/a b&c.png", new Uint8Array([1, 2, 3]), "image/png");
    const req = s3.seen[0]!;
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/vol/input/a b&c.png");
    expect(req.headers["content-type"]).toBe("image/png");
    expect(req.headers["content-length"]).toBe("3");
    expect(req.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=user_abc\/\d{8}\/EU-RO-1\/s3\/aws4_request, SignedHeaders=/,
    );
    expect(req.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses keys that escape the volume", async () => {
    for (const bad of ["../other/x", "/abs", "a//b", "a/./b", "in\\win.png", ""])
      await expect(client.head(bad)).rejects.toThrow("올바르지 않은 볼륨 경로");
  });

  it("streams an object and reports a missing one as a 404 VolumeError", async () => {
    s3.objects.set("/vol/output/x.png", Buffer.from("png-bytes"));
    const got = await client.getStream("output/x.png");
    expect(got.contentType).toBe("image/png");
    expect(got.size).toBe(9);
    expect(Buffer.from(await new Response(got.body).arrayBuffer()).toString()).toBe("png-bytes");
    const err = await client.getStream("output/missing.png").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VolumeError);
    expect(standIn<VolumeError>(err).status).toBe(404);
    expect(standIn<VolumeError>(err).code).toBe("NoSuchKey");
  });

  it("reads JSON, null when absent, and rejects non-JSON", async () => {
    s3.objects.set("/vol/meta/worker.json", Buffer.from('{"image":"x"}'));
    s3.objects.set("/vol/meta/bad.json", Buffer.from("nope"));
    expect(await client.getJson("meta/worker.json")).toEqual({ image: "x" });
    expect(await client.getJson("meta/none.json")).toBeNull();
    await expect(client.getJson("meta/bad.json")).rejects.toThrow("JSON");
  });

  it("answers HEAD with etag and size, null for a missing key, and deletes idempotently", async () => {
    s3.objects.set("/vol/meta/object_info.json", Buffer.from("{}"));
    expect(await client.head("meta/object_info.json")).toEqual({
      etag: '"abc"',
      size: 2,
      contentType: "application/json",
    });
    expect(await client.head("meta/none.json")).toBeNull();
    await client.delete("meta/object_info.json");
    await client.delete("meta/object_info.json");
    expect(s3.objects.has("/vol/meta/object_info.json")).toBe(false);
  });

  it("lists a prefix across pages, shallow when asked", async () => {
    for (let i = 0; i < 5; i++) s3.objects.set(`/vol/input/f${i}.png`, Buffer.alloc(i + 1));
    s3.objects.set("/vol/input/sub/nested.png", Buffer.alloc(1));
    s3.objects.set("/vol/output/o.png", Buffer.alloc(1));
    // The client asks for 1000 per page; the fake serves two, so the walk takes three pages.
    s3.setPageSize(2);
    const all = await client.list("input/");
    expect(s3.seen.filter((r) => r.query.get("list-type") === "2")).toHaveLength(3);
    expect(s3.seen.at(-1)!.query.get("continuation-token")).toBe("input/f3.png");
    s3.setPageSize(null);
    expect(all.map((o) => o.key).toSorted()).toEqual([
      "input/f0.png",
      "input/f1.png",
      "input/f2.png",
      "input/f3.png",
      "input/f4.png",
      "input/sub/nested.png",
    ]);
    expect(all.find((o) => o.key === "input/f2.png")).toMatchObject({
      size: 3,
      lastModified: new Date("2026-10-22T01:02:03.000Z"),
    });
    const shallow = await client.list("input/", { shallow: true });
    expect(shallow.map((o) => o.key)).not.toContain("input/sub/nested.png");
    expect(shallow).toHaveLength(5);
    expect(s3.seen.at(-1)!.query.get("delimiter")).toBe("/");
  });

  it("follows continuation tokens", () => {
    const first = parseListXml(
      "<ListBucketResult><Contents><Key>a&amp;b</Key><Size>1</Size></Contents>" +
        "<IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken></ListBucketResult>",
    );
    expect(first).toEqual({
      objects: [{ key: "a&b", size: 1, lastModified: null }],
      truncated: true,
      next: "tok",
    });
    expect(
      parseListXml("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"),
    ).toEqual({ objects: [], truncated: false, next: null });
  });

  it("turns an access denial into a readable error", async () => {
    s3.failNext(403);
    const err = await client.head("meta/worker.json").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VolumeError);
    expect(standIn<VolumeError>(err).status).toBe(403);
    expect(standIn<VolumeError>(err).message).toContain("S3 키");
  });

  it("reports an unreachable endpoint", async () => {
    const dead = new VolumeClient({
      endpoint: "http://127.0.0.1:9",
      region: "EU-RO-1",
      bucket: "vol",
      accessKeyId: "a",
      secretAccessKey: "b",
    });
    const err = await dead.head("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VolumeError);
    expect(standIn<VolumeError>(err).status).toBe(0);
  });
});
