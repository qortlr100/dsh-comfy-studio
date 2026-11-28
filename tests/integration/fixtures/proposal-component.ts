// A throwaway feature component for the proposal test: one reducer and two operations. An agent's
// call of `probe_card.remove` writes a proposal that the user accepts or rejects; agents get no
// tool for `probe_card.review`. dsh's Node loads this file directly through a patch row, so it
// takes its services from `ctx` and imports types only.

import type { Context } from "@deepseek-ai/cordis";
import type { OperationSpec, Reducer } from "@cs/project";

interface CardSlice {
  removed: string[];
}

declare module "@cs/project/types" {
  interface ComponentStates {
    /** The slice of this fixture's component. */
    probe_card?: CardSlice;
  }
}

export const COMPONENT = "probe_card";
export const PROPOSE_OPERATION = "probe_card.remove";
export const NONE_OPERATION = "probe_card.review";

const cardReducer: Reducer<"probe_card"> = {
  initial: () => ({ removed: [] }),
  reduce(slice, record) {
    if (record.operation !== PROPOSE_OPERATION || record.status !== "done") return slice;
    return { removed: [...(slice?.removed ?? []), String(record.params["text"])] };
  },
};

const base: Omit<OperationSpec, "name" | "description" | "agent" | "summarize"> = {
  component: COMPONENT,
  version: "1",
  params: { text: { type: "string", required: true, description: "The card." } },
  inputs: {},
  outputs: [],
  deterministic: false,
  resource: "none",
  execute: () => Promise.resolve({ outputs: [] }),
};

const remove: OperationSpec = {
  ...base,
  name: PROPOSE_OPERATION,
  description: "Remove a card from the project. Exists only in the integration test.",
  agent: "propose",
  summarize: (record) => `removed the card ${String(record.params["text"])}`,
};

const review: OperationSpec = {
  ...base,
  name: NONE_OPERATION,
  description: "Mark a card reviewed. Exists only in the integration test.",
  agent: "none",
  summarize: (record) => `reviewed the card ${String(record.params["text"])}`,
};

export const inject = ["csProject"];

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.csProject.registerComponent(COMPONENT));
  ctx.effect(() => ctx.csProject.registerReducer(COMPONENT, cardReducer));
  ctx.effect(() => ctx.csProject.registerOperation(remove));
  ctx.effect(() => ctx.csProject.registerOperation(review));
}
