// A throwaway feature component for the view API test: one reducer and one operation that adds
// a memo. dsh's Node loads this file directly through a patch row, so it takes its services
// from `ctx` and imports types only.

import type { Context } from "@deepseek-ai/cordis";
import type { OperationSpec, Reducer } from "@cs/project";

interface MemoSlice {
  texts: string[];
}

declare module "@cs/project/types" {
  interface ComponentStates {
    /** The slice of this fixture's component. */
    probe_memo?: MemoSlice;
  }
}

export const COMPONENT = "probe_memo";
export const OPERATION = "probe_memo.add";
export const LABEL = "메모 추가";

const memoReducer: Reducer<"probe_memo"> = {
  initial: () => ({ texts: [] }),
  reduce(slice, record) {
    if (record.operation !== OPERATION || record.status !== "done") return slice;
    return { texts: [...(slice?.texts ?? []), String(record.params["text"])] };
  },
};

const memoAdd: OperationSpec = {
  name: OPERATION,
  component: COMPONENT,
  version: "1",
  description: "Add a memo to the project. Exists only in the integration test.",
  label: LABEL,
  params: { text: { type: "string", required: true, description: "The memo." } },
  inputs: {},
  outputs: [],
  deterministic: false,
  resource: "none",
  summarize: (record) => `added the memo ${String(record.params["text"])}`,
  execute: () => Promise.resolve({ outputs: [] }),
};

export const inject = ["csProject"];

export function apply(ctx: Context): void {
  // The key comes first: a reducer and an operation register under a known component.
  ctx.effect(() => ctx.csProject.registerComponent(COMPONENT));
  ctx.effect(() => ctx.csProject.registerReducer(COMPONENT, memoReducer));
  ctx.effect(() => ctx.csProject.registerOperation(memoAdd));
}
