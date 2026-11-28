/**
 * The reducer of the generation component: its state slice is one setting, whether an agent's call of `gen.run` runs at
 * once. The batches themselves are the project's `gen.run` records and are not repeated here. The reducer is pure and
 * never throws; the `params` of a record are outside data to it, so a record whose params do not parse is skipped.
 *
 * @module @cs/generation/reducer
 */
import type { Reducer } from "@cs/project/types";
import { z as zod } from "zod";
import { summaryOf } from "./read.ts";
import { GEN_OPERATIONS, type GenSlice } from "./types.ts";

const settingsParams = zod.object({ agent_run: zod.boolean() });

/** The reducer of the `gen` slice. */
export const genReducer: Reducer<"gen"> = {
  initial(): GenSlice {
    return { settings: { agent_run: false } };
  },
  reduce(slice, record) {
    if (record.status !== "done" || record.operation !== GEN_OPERATIONS.settings) return slice;
    const params = settingsParams.safeParse(record.params);
    if (!params.success || params.data.agent_run === slice?.settings.agent_run) return slice;
    return { settings: { agent_run: params.data.agent_run } };
  },
  agentSummary(_slice, _assets, state) {
    return { generation: summaryOf(state) };
  },
};
