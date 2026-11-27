/**
 * The generation catalog as the `csCatalog` Cordis service: a provider-neutral registry of the places a generation
 * request can run. Generation provider plugins register one entry per place, keyed by primitive, provider and target;
 * feature components register their operations while the catalog serves one of their primitives, and run a request
 * with the entry that a call's key names. The catalog knows no server and no workflow, and adds nothing to the system
 * prompt.
 *
 * The frame follows DreamVerse `@dv/models`; see THIRD_PARTY_NOTICES.md.
 *
 * @module @cs/catalog
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type {
  CatalogEntry,
  CatalogFilter,
  CatalogKey,
  CatalogSummaryItem,
  PrimitiveId,
} from "./types.ts";

export { NOT_QUEUED, RequestRejected } from "./rejected.ts";
export type * from "./types.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The generation catalog: the entries provider plugins register, by primitive, provider and target. */
    csCatalog: CsCatalog;
  }
}

/** `csCatalog` plugin configuration. */
export interface Config {
  /** How long `summary()` waits for one entry's `facts()` before it lists the entry without facts, in ms. */
  factsTimeoutMs: number;
}

/** Runtime schema of {@link Config}. */
export const Config: z<Config> = z.object({
  factsTimeoutMs: z.natural().min(1).default(5000),
});

/** The optional methods of an entry, as `summary()` names them, in the order it lists them. */
const ABILITIES = [
  "listModelFiles",
  "listRuns",
  "modelFileMetadata",
  "nodeCatalog",
  "resume",
] as const;

/**
 * Format a catalog key as one string, such as `graph/comfy/server-1`, for messages. The parts may hold a slash, so
 * the text is not a key to look an entry up by.
 * @param key - the key.
 * @returns `primitive/provider/target`.
 */
export function formatCatalogKey(key: CatalogKey): string {
  return `${key.primitive}/${key.provider}/${key.target}`;
}

/**
 * Whether an entry is of one of the given primitives; narrows the entry to them.
 * @param entry - the entry.
 * @param primitives - the primitives.
 * @returns true when the entry's primitive is in `primitives`.
 */
export function servesPrimitive<P extends PrimitiveId>(
  entry: CatalogEntry,
  primitives: readonly P[],
): entry is CatalogEntry<P> {
  return primitives.some((primitive) => primitive === entry.primitive);
}

/**
 * @param key - a key.
 * @returns the text that tells two keys apart whatever characters their parts hold.
 */
function indexOf(key: CatalogKey): string {
  return JSON.stringify([key.primitive, key.provider, key.target]);
}

/**
 * @param error - a thrown value.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The catalog service: entries by key, change listeners, and the summary the views read. */
export default class CsCatalog extends Service {
  static Config = Config;

  private readonly entries = new Map<string, CatalogEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly config: Config;

  constructor(ctx: Context, config: Config) {
    super(ctx, "csCatalog");
    this.config = Config(config);
  }

  /**
   * Register an entry. A provider plugin calls it inside `ctx.effect`, so that the entry leaves with the plugin.
   * @param entry - one place a request of the entry's primitive can run.
   * @returns a function that removes the entry; calling it again does nothing.
   * @throws Error when the provider or the target is empty, or an entry with the same key is registered.
   */
  register<P extends PrimitiveId>(entry: CatalogEntry<P>): () => void {
    if (entry.provider === "" || entry.target === "") {
      throw new Error("csCatalog: an entry needs a provider and a target.");
    }
    const index = indexOf(entry);
    if (this.entries.has(index)) {
      throw new Error(`csCatalog: entry "${formatCatalogKey(entry)}" is already registered.`);
    }
    this.entries.set(index, entry);
    this.notify();
    return () => {
      if (this.entries.get(index) !== entry) return;
      this.entries.delete(index);
      this.notify();
    };
  }

  /**
   * Read one entry.
   * @param key - the entry's primitive, provider and target.
   * @returns the entry, or undefined when no entry is registered under `key`.
   */
  get<P extends PrimitiveId>(key: CatalogKey<P>): CatalogEntry<P> | undefined {
    const entry = this.entries.get(indexOf(key));
    return entry !== undefined && servesPrimitive(entry, [key.primitive]) ? entry : undefined;
  }

  /**
   * Read the entries that match a filter.
   * @param filter - the primitive and provider to match; an absent field matches every entry.
   * @returns the matching entries, in registration order.
   */
  list(filter: CatalogFilter = {}): CatalogEntry[] {
    return [...this.entries.values()].filter(
      (entry) =>
        (filter.primitive === undefined || entry.primitive === filter.primitive) &&
        (filter.provider === undefined || entry.provider === filter.provider),
    );
  }

  /**
   * Listen to registrations and removals.
   * @param listener - called after each change. A listener that throws is logged and does not stop the change or the
   *   other listeners.
   * @returns a function that removes the listener.
   */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Keep a registration of a consumer, such as its operation, while the catalog holds an entry of one of its
   * primitives.
   * @param primitives - the primitives that the consumer runs.
   * @param start - registers the consumer's part when the first entry of one of `primitives` arrives; returns its
   *   disposer.
   * @returns a function that stops listening and disposes the registration; pass it to `ctx.effect`.
   */
  whileServing(primitives: readonly PrimitiveId[], start: () => () => void): () => void {
    let stop: (() => void) | null = null;
    // The registration starts with the first entry of one of the primitives and stops when the last one is removed.
    const sync = (): void => {
      const serving = this.list().some((entry) => servesPrimitive(entry, primitives));
      if (serving === (stop !== null)) return;
      stop?.();
      stop = serving ? start() : null;
    };
    sync();
    const unlisten = this.onChanged(sync);
    return () => {
      unlisten();
      stop?.();
      stop = null;
    };
  }

  /**
   * The catalog as the views read it: every entry in registration order, with its key, its description, the optional
   * methods it has, and its facts.
   * @returns the entries; an entry whose `facts()` rejects or does not answer within `factsTimeoutMs`, such as one
   *   whose server cannot be reached, has facts null and a problem.
   */
  async summary(): Promise<CatalogSummaryItem[]> {
    return await Promise.all(
      this.list().map(async (entry) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<{ facts: null; problem: string }>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              facts: null,
              problem: `No answer within ${this.config.factsTimeoutMs} ms.`,
            });
          }, this.config.factsTimeoutMs);
        });
        // The facts of an unreachable or slow server are unknown; the entry still lists its key and description.
        const read = Promise.resolve()
          .then(() => entry.facts())
          .then(
            (facts) => ({ facts, problem: null }),
            (error: unknown) => ({ facts: null, problem: messageOf(error) }),
          );
        const { facts, problem } = await Promise.race([read, late]);
        clearTimeout(timer);
        return {
          primitive: entry.primitive,
          provider: entry.provider,
          target: entry.target,
          description: entry.description,
          abilities: ABILITIES.filter((name) => typeof Reflect.get(entry, name) === "function"),
          facts,
          problem,
        };
      }),
    );
  }

  private notify(): void {
    // A listener may add or remove listeners while it runs; a Set keeps iterating correctly through both.
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.ctx.logger("csCatalog").warn(error);
      }
    }
  }
}
