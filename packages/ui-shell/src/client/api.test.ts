import { describe, expect, it } from "vitest";
import { ApiError, createShellClient } from "./api.ts";

const project = { id: "p1", title: "P", created_at: "2026-01-01T00:00:00.000Z", path: "/p" };

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake `fetch` answering every call with `response`, recording the calls. */
function fake(response: Response | (() => Response)) {
  const calls: Call[] = [];
  const impl: typeof fetch = (input, init) => {
    calls.push({ url: typeof input === "string" ? input : "", init });
    return Promise.resolve(typeof response === "function" ? response() : response);
  };
  return { calls, client: createShellClient(impl) };
}

function bodyOf(call: Call | undefined): string {
  const body = call?.init?.body;
  if (typeof body !== "string") throw new Error("expected a string body");
  return body;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createShellClient", () => {
  it("lists projects with a plain GET", async () => {
    const { calls, client } = fake(json([project]));
    await expect(client.listProjects()).resolves.toEqual([project]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/cs/projects");
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it("rejects a list that is not an array of projects", async () => {
    await expect(fake(json({ projects: [] })).client.listProjects()).rejects.toThrow();
    await expect(fake(json([{ id: 1 }])).client.listProjects()).rejects.toThrow();
  });

  it("creates a project with title and the view surface", async () => {
    const { calls, client } = fake(json(project));
    await expect(client.createProject("P")).resolves.toEqual(project);
    expect(calls[0]?.url).toBe("/api/cs/projects");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(bodyOf(calls[0]))).toEqual({ title: "P", surface: "view" });
  });

  it("renames and resolves the stored title", async () => {
    const { calls, client } = fake(json({ title: "P 2" }));
    await expect(client.renameProject("p1", "P")).resolves.toBe("P 2");
    expect(calls[0]?.url).toBe("/api/cs/projects/rename");
    expect(JSON.parse(bodyOf(calls[0]))).toEqual({ project: "p1", title: "P" });
  });

  it("removes a project", async () => {
    const { calls, client } = fake(json({ ok: true }));
    await expect(client.removeProject("p1")).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("/api/cs/projects/delete");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(bodyOf(calls[0]))).toEqual({ project: "p1" });
  });

  it("maps the server's error body to ApiError", async () => {
    const { client } = fake(json({ error: "no such project", code: "unknown_project" }, 404));
    const error = await client.removeProject("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: "ApiError",
      status: 404,
      code: "unknown_project",
      message: "no such project",
    });
  });

  it("falls back to http_error for bodies that are not ours", async () => {
    for (const response of [
      new Response("Unauthorized", { status: 401 }),
      json({ message: "forbidden" }, 403),
    ]) {
      const { client } = fake(response);
      const error = await client.listProjects().catch((e: unknown) => e);
      if (!(error instanceof ApiError)) throw new Error("expected ApiError");
      expect(error.code).toBe("http_error");
      expect(error.message).toContain(String(error.status));
    }
  });

  it("rejects a 2xx answer with a malformed body", async () => {
    await expect(fake(new Response("nope")).client.listProjects()).rejects.toThrow();
    await expect(fake(json({})).client.createProject("P")).rejects.toThrow();
    await expect(fake(json({ title: 3 })).client.renameProject("p", "t")).rejects.toThrow();
    await expect(fake(new Response("")).client.removeProject("p")).rejects.toThrow();
  });

  it("lets a network failure through", async () => {
    const client = createShellClient(() => Promise.reject(new TypeError("offline")));
    await expect(client.listProjects()).rejects.toThrow("offline");
  });
});
