import { describe, expect, it } from "vitest";
import { VISITED_KEY } from "./ids.ts";
import { claimFirstVisit } from "./visit.ts";
import type { MarkerStorage } from "./visit.ts";

function memory(): MarkerStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

describe("claimFirstVisit", () => {
  it("is true once, and marks the browser", () => {
    const storage = memory();
    expect(claimFirstVisit(storage)).toBe(true);
    expect(storage.data.has(VISITED_KEY)).toBe(true);
    expect(claimFirstVisit(storage)).toBe(false);
  });

  it("counts a browser without storage as a first visit", () => {
    expect(claimFirstVisit(null)).toBe(true);
  });

  it("does not throw when storage refuses reads or writes", () => {
    const refusing: MarkerStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(claimFirstVisit(refusing)).toBe(true);
    expect(claimFirstVisit(refusing)).toBe(true);
  });
});
