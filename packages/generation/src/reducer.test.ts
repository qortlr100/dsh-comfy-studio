/**
 * The generation reducer: one setting from the done `gen.settings` records, and the agent summary.
 */
import { SESSION } from "@cs/project/testing/support";
import { describe, expect, it } from "vitest";
import { genReducer } from "./reducer.ts";
import type { GenSlice } from "./types.ts";
import { batch, recordOf, stateOf } from "./testing/states.ts";

/** A `gen.settings` record. */
function settings(agentRun: unknown, status: "done" | "failed" | "pending" = "done") {
  return recordOf("s", {
    operation: "gen.settings",
    status,
    params: { agent_run: agentRun },
  });
}

describe("genReducer", () => {
  it("starts with agents proposing", () => {
    expect(genReducer.initial()).toEqual({ settings: { agent_run: false } });
  });

  it("sets agent_run from a done gen.settings record, in write order", () => {
    let slice: GenSlice | undefined = genReducer.initial();

    slice = genReducer.reduce(slice, settings(true));
    expect(slice?.settings.agent_run).toBe(true);
    slice = genReducer.reduce(slice, settings(false));
    expect(slice?.settings.agent_run).toBe(false);
  });

  it("changes nothing for a record that is not done, malformed, or another operation", () => {
    const slice = genReducer.initial();

    expect(genReducer.reduce(slice, settings(true, "failed"))).toBe(slice);
    expect(genReducer.reduce(slice, settings(true, "pending"))).toBe(slice);
    expect(genReducer.reduce(slice, settings("yes"))).toBe(slice);
    expect(genReducer.reduce(slice, recordOf("x", { operation: "gen.run" }))).toBe(slice);
    expect(genReducer.reduce(slice, recordOf("y", { operation: "gen.settings", params: {} }))).toBe(
      slice,
    );
    expect(genReducer.reduce(slice, recordOf("z", { operation: null }))).toBe(slice);
  });

  it("keeps the same slice when the setting does not change", () => {
    const on = genReducer.reduce(genReducer.initial(), settings(true));

    expect(genReducer.reduce(on, settings(true))).toBe(on);
  });

  it("gives the agent the generation summary", () => {
    const slice = { settings: { agent_run: true } };
    const state = stateOf({ gen: slice, records: [batch("01", "pending")] });

    const fields = genReducer.agentSummary?.(slice, { url: () => "" }, state, SESSION);

    expect(fields).toEqual({
      generation: {
        agent_may_run: true,
        unfinished: 1,
        recent: [{ id: "01", label: "generation", status: "pending", outputs: 0 }],
      },
    });
  });
});
