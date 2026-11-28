import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { hostOf } from "./host.ts";
import { AGENT_PRESET } from "./ids.ts";
import { strings } from "./strings.ts";

const store = <T>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} });

/** Only the services `hostOf(...).openWorkspace` reads, with dsh's calls recorded. */
function fakeContext() {
  const calls: unknown[][] = [];
  const value: unknown = {
    workspaces: {
      list: store({
        phase: "ready",
        items: [{ workspaceId: "A", sessionIds: [] }],
        archivedSessionIds: [],
      }),
    },
    sessions: { list: store({ phase: "ready", ids: [], byId: {} }) },
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
});
