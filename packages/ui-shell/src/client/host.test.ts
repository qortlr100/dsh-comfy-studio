import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { hostOf } from "./host.ts";
import { AGENT_PRESET } from "./ids.ts";
import { strings } from "./strings.ts";

const store = <T>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} });

/** Only the services `hostOf(...)` reads for these calls, with dsh's calls recorded. */
function fakeContext(options: { created?: string } = {}) {
  const calls: unknown[][] = [];
  const value: unknown = {
    workspaces: {
      list: store({
        phase: "ready",
        items: [{ workspaceId: "A", sessionIds: ["s1", "s2"] }],
        archivedSessionIds: [],
      }),
    },
    sessions: {
      list: store({
        phase: "ready",
        ids: ["s1", "s2"],
        byId: {
          s1: {
            id: "s1",
            blank: true,
            updatedAt: 1,
            projectionValues: { agentPreset: "standard" },
          },
          s2: { id: "s2", blank: true, updatedAt: 1, projectionValues: { agentPreset: null } },
        },
      }),
      create: (...args: unknown[]) => {
        calls.push(["create", ...args]);
        return Promise.resolve(options.created ?? "s1");
      },
      refreshProjections: (...args: unknown[]) => {
        calls.push(["refreshProjections", ...args]);
        return Promise.resolve();
      },
    },
    sidebarRight: { mounted: store(undefined) },
    uiWorkspace: {
      openWorkspace: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    },
  };
  if (!isContext(value)) throw new Error("unreachable");
  return { ctx: value, calls };
}

// The fake carries just the services the code under test reads.
function isContext(value: unknown): value is Context {
  return typeof value === "object" && value !== null && "uiWorkspace" in value;
}

describe("hostOf", () => {
  it("opens a workspace's session under our agent preset", async () => {
    const { ctx, calls } = fakeContext();
    await hostOf(ctx).openWorkspace("A");
    expect(calls).toEqual([["A", undefined, { agentPreset: AGENT_PRESET }]]);
    expect(AGENT_PRESET).toBe("comfy-studio");
  });

  it("refuses a workspace dsh does not list, without calling dsh", async () => {
    const { ctx, calls } = fakeContext();
    await expect(hostOf(ctx).openWorkspace("B")).rejects.toThrow(strings.workspaceNotReady);
    expect(calls).toEqual([]);
  });

  it("reads the preset dsh's session list reports", () => {
    const host = hostOf(fakeContext().ctx);
    expect(host.sessionPreset("s1")).toBe("standard");
    expect(host.sessionPreset("s2")).toBeUndefined();
    expect(host.sessionPreset("nope")).toBeUndefined();
  });

  it("selects a preset by naming the blank session for dsh to reuse", async () => {
    const { ctx, calls } = fakeContext();
    await expect(hostOf(ctx).selectPreset("A", "s1", AGENT_PRESET)).resolves.toBe("selected");
    expect(calls).toEqual([
      ["create", { workspaceId: "A", sessionId: "s1", agentPreset: AGENT_PRESET }],
    ]);
  });

  it("reports a session dsh declined to reuse and reloads its row", async () => {
    const { ctx, calls } = fakeContext({ created: "s9" });
    await expect(hostOf(ctx).selectPreset("A", "s1", AGENT_PRESET)).resolves.toBe("declined");
    expect(calls).toEqual([
      ["create", { workspaceId: "A", sessionId: "s1", agentPreset: AGENT_PRESET }],
      ["refreshProjections", "s1"],
    ]);
  });

  it("refuses an unlisted workspace or session without calling dsh", async () => {
    const { ctx, calls } = fakeContext();
    const host = hostOf(ctx);
    await expect(host.selectPreset("B", "s1", AGENT_PRESET)).rejects.toThrow(
      strings.workspaceNotReady,
    );
    await expect(host.selectPreset("A", "nope", AGENT_PRESET)).rejects.toThrow(
      strings.unknownSession,
    );
    expect(calls).toEqual([]);
  });
});
