import { describe, expect, it, vi } from "vitest";
import { createShellStore } from "./store.ts";

describe("createShellStore", () => {
  it("starts with defaults merged with the initial patch", () => {
    expect(createShellStore().getSnapshot()).toEqual({
      projects: null,
      projectId: null,
      sessionId: undefined,
      chatRequest: 0,
      failure: null,
    });
    expect(createShellStore({ projectId: "p" }).getSnapshot().projectId).toBe("p");
  });

  it("keeps the snapshot and stays silent when nothing changed", () => {
    const store = createShellStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.set({});
    store.set({ projectId: null, sessionId: undefined });
    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("replaces the snapshot and notifies once per effective change", () => {
    const store = createShellStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.set({ projectId: "p", sessionId: "s" });
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot()).toMatchObject({ projectId: "p", sessionId: "s" });
    expect(listener).toHaveBeenCalledTimes(1);
    const after = store.getSnapshot();
    expect(store.getSnapshot()).toBe(after);
  });

  it("compares with Object.is, so a new list object is a change", () => {
    const store = createShellStore({ projects: [] });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ projects: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe and survives removal during notification", () => {
    const store = createShellStore();
    const calls: string[] = [];
    const offFirst = store.subscribe(() => {
      calls.push("first");
      offFirst();
    });
    store.subscribe(() => calls.push("second"));
    store.set({ projectId: "a" });
    store.set({ projectId: "b" });
    expect(calls).toEqual(["first", "second", "second"]);
  });

  it("keeps no state between stores", () => {
    const a = createShellStore();
    const b = createShellStore();
    a.set({ projectId: "p" });
    expect(b.getSnapshot().projectId).toBeNull();
  });
});
