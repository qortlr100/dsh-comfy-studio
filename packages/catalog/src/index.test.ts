/**
 * Unit tests of the `csCatalog` service: registration, lookup, change notification, `whileServing` and `summary`.
 */
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { defined } from "@cs/project/testing/support";
import CsCatalog from "./index.ts";
import { fakeGraphEntry } from "./testing/fake-provider.ts";

/**
 * Mount the service on a fresh context, which is disposed when the test finishes.
 * @param factsTimeoutMs - the service's `factsTimeoutMs`.
 * @returns the service.
 */
async function mount(factsTimeoutMs = 5000): Promise<CsCatalog> {
  const context = new Context();
  onTestFinished(async () => {
    await context.fiber.dispose();
  });
  await context.plugin(CsCatalog, { factsTimeoutMs }).await();
  return context.csCatalog;
}

describe("register", () => {
  it("adds an entry, and the returned function removes it; calling it twice is harmless", async () => {
    const catalog = await mount();
    const entry = fakeGraphEntry();
    const remove = catalog.register(entry);
    expect(catalog.list()).toEqual([entry]);
    remove();
    expect(catalog.list()).toEqual([]);
    remove();
    expect(catalog.list()).toEqual([]);
  });

  it("does not let an old remover remove a newer entry with the same key", async () => {
    const catalog = await mount();
    const remove = catalog.register(fakeGraphEntry());
    remove();
    const next = fakeGraphEntry();
    catalog.register(next);
    remove();
    expect(catalog.list()).toEqual([next]);
  });

  it("throws for the same key twice", async () => {
    const catalog = await mount();
    catalog.register(fakeGraphEntry());
    expect(() => catalog.register(fakeGraphEntry())).toThrow(/graph\/fake\/one/);
  });

  it("throws for an empty provider or target", async () => {
    const catalog = await mount();
    expect(() => catalog.register(fakeGraphEntry({ provider: "" }))).toThrow(/provider/);
    expect(() => catalog.register(fakeGraphEntry({ target: "" }))).toThrow(/target/);
    expect(catalog.list()).toEqual([]);
  });

  it("keeps keys whose parts hold a slash apart", async () => {
    const catalog = await mount();
    const first = fakeGraphEntry({ provider: "a/b", target: "c" });
    const second = fakeGraphEntry({ provider: "a", target: "b/c" });
    catalog.register(first);
    catalog.register(second);
    expect(catalog.get({ primitive: "graph", provider: "a/b", target: "c" })).toBe(first);
    expect(catalog.get({ primitive: "graph", provider: "a", target: "b/c" })).toBe(second);
  });
});

describe("get and list", () => {
  it("gets an entry by key, and undefined for an unknown key", async () => {
    const catalog = await mount();
    const entry = fakeGraphEntry();
    catalog.register(entry);
    expect(catalog.get({ primitive: "graph", provider: "fake", target: "one" })).toBe(entry);
    expect(catalog.get({ primitive: "graph", provider: "fake", target: "two" })).toBeUndefined();
    expect(catalog.get({ primitive: "graph", provider: "other", target: "one" })).toBeUndefined();
  });

  it("lists in registration order and filters by provider and primitive", async () => {
    const catalog = await mount();
    const first = fakeGraphEntry({ provider: "p1", target: "t1" });
    const second = fakeGraphEntry({ provider: "p2", target: "t1" });
    const third = fakeGraphEntry({ provider: "p1", target: "t2" });
    catalog.register(first);
    catalog.register(second);
    catalog.register(third);
    expect(catalog.list()).toEqual([first, second, third]);
    expect(catalog.list({ provider: "p1" })).toEqual([first, third]);
    expect(catalog.list({ primitive: "graph" })).toEqual([first, second, third]);
    expect(catalog.list({ primitive: "graph", provider: "p2" })).toEqual([second]);
    expect(catalog.list({ provider: "none" })).toEqual([]);
  });
});

describe("onChanged", () => {
  it("fires on register and on removal, and not after its remover ran", async () => {
    const catalog = await mount();
    const listener = vi.fn();
    const unlisten = catalog.onChanged(listener);
    const remove = catalog.register(fakeGraphEntry({ target: "a" }));
    expect(listener).toHaveBeenCalledTimes(1);
    remove();
    expect(listener).toHaveBeenCalledTimes(2);
    unlisten();
    catalog.register(fakeGraphEntry({ target: "b" }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not stop register or the other listeners when a listener throws", async () => {
    const catalog = await mount();
    const after = vi.fn();
    catalog.onChanged(() => {
      throw new Error("listener failed");
    });
    catalog.onChanged(after);
    const entry = fakeGraphEntry();
    expect(() => catalog.register(entry)).not.toThrow();
    expect(catalog.list()).toEqual([entry]);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("whileServing", () => {
  it("starts with the first entry, stops with the last, and starts again with a new entry", async () => {
    const catalog = await mount();
    const dispose = vi.fn();
    const start = vi.fn(() => dispose);
    catalog.whileServing(["graph"], start);
    expect(start).not.toHaveBeenCalled();

    const removeA = catalog.register(fakeGraphEntry({ target: "a" }));
    expect(start).toHaveBeenCalledTimes(1);
    const removeB = catalog.register(fakeGraphEntry({ target: "b" }));
    expect(start).toHaveBeenCalledTimes(1);
    removeA();
    expect(dispose).not.toHaveBeenCalled();
    removeB();
    expect(dispose).toHaveBeenCalledTimes(1);

    catalog.register(fakeGraphEntry({ target: "c" }));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("starts at once when an entry is already there", async () => {
    const catalog = await mount();
    catalog.register(fakeGraphEntry());
    const start = vi.fn(() => () => undefined);
    catalog.whileServing(["graph"], start);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("stops, and stops listening, when the returned function is called", async () => {
    const catalog = await mount();
    const dispose = vi.fn();
    const start = vi.fn(() => dispose);
    const remove = catalog.register(fakeGraphEntry({ target: "a" }));
    const stop = catalog.whileServing(["graph"], start);
    expect(start).toHaveBeenCalledTimes(1);
    stop();
    expect(dispose).toHaveBeenCalledTimes(1);
    remove();
    catalog.register(fakeGraphEntry({ target: "b" }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("summary", () => {
  it("lists key, description and facts of a reachable entry; abilities follow the optional methods", async () => {
    const catalog = await mount();
    catalog.register(fakeGraphEntry({ target: "plain", label: "Plain" }));
    catalog.register(
      fakeGraphEntry({ target: "rich", label: "Rich", lookups: true, resumable: true }),
    );
    const [plain, rich] = await catalog.summary();
    expect(plain).toEqual({
      primitive: "graph",
      provider: "fake",
      target: "plain",
      description: "A fake server for tests.",
      abilities: [],
      facts: { label: "Plain", kind: "fake", system: { version: "0.0.0" } },
      problem: null,
    });
    expect(defined(rich, "second item").abilities).toEqual([
      "listModelFiles",
      "listRuns",
      "modelFileMetadata",
      "nodeCatalog",
      "resume",
    ]);
  });

  it("gives an entry whose facts() rejects null facts and the message as the problem", async () => {
    const catalog = await mount();
    catalog.register(fakeGraphEntry({ unreachable: "connection refused" }));
    const [item] = await catalog.summary();
    expect(item).toMatchObject({ facts: null, problem: "connection refused" });
  });

  it("gives an entry whose facts() never resolves a problem after factsTimeoutMs, and still lists the others", async () => {
    const catalog = await mount(1000);
    catalog.register(fakeGraphEntry({ target: "fine", label: "Fine" }));
    catalog.register({
      ...fakeGraphEntry({ target: "stuck" }),
      facts: () => new Promise<never>(() => undefined),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const pending = catalog.summary();
    await vi.advanceTimersByTimeAsync(1000);
    const [fine, stuck] = await pending;
    expect(fine).toMatchObject({ target: "fine", facts: { label: "Fine" }, problem: null });
    expect(stuck).toMatchObject({
      target: "stuck",
      facts: null,
      problem: "No answer within 1000 ms.",
    });
  });
});

describe("whileServing with a consumer that changes the catalog itself", () => {
  it("starts once when start registers an entry, and disposes once when the last entry leaves", async () => {
    const catalog = await mount();
    let starts = 0;
    let stops = 0;
    let removeOwn: (() => void) | undefined;
    catalog.whileServing(["graph"], () => {
      starts += 1;
      // A change of the catalog from inside `start`: it must not start the consumer a second time.
      removeOwn = catalog.register(fakeGraphEntry({ target: `own-${String(starts)}` }));
      return () => {
        stops += 1;
        removeOwn?.();
      };
    });

    const removeFirst = catalog.register(fakeGraphEntry({ target: "first" }));
    expect(starts).toBe(1);
    removeFirst();
    // The consumer's own entry still serves the primitive.
    expect(stops).toBe(0);
    removeOwn?.();
    expect(stops).toBe(1);
    expect(starts).toBe(1);
    expect(catalog.list()).toEqual([]);
  });
});
