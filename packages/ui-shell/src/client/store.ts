// The shell state store: one snapshot object per effective change, no module-level state.

import type { ShellState, ShellStore } from "./contract.ts";

/**
 * Make a store for the shell state.
 * @param initial - fields that replace the defaults (nothing open, lists not read yet).
 * @returns the store; `set` notifies only when a field differs (`Object.is`).
 */
export function createShellStore(initial?: Partial<ShellState>): ShellStore {
  let snapshot: ShellState = {
    projects: null,
    projectId: null,
    sessionId: undefined,
    chatRequest: 0,
    navigations: 0,
    restoredSession: undefined,
    failure: null,
    ...initial,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(patch) {
      const same = Object.entries(patch).every(([key, value]) =>
        Object.is(value, Reflect.get(snapshot, key)),
      );
      if (same) return;
      snapshot = { ...snapshot, ...patch };
      for (const listener of Array.from(listeners)) listener();
    },
  };
}
