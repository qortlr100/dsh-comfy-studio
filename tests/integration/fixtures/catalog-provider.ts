// A throwaway generation provider and its consumer for the catalog test. As a provider it
// registers one fake entry in the catalog; as a feature component it has operations that add
// and remove a second entry and that run a graph on an entry. dsh's Node loads this file
// directly through a patch row, so it takes its services from `ctx`.

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@cs/catalog";
import { fakeGraphEntry } from "@cs/catalog/testing/fake-provider";
import type { OperationSpec } from "@cs/project";

export const COMPONENT = "probe_catalog";
export const ADD = "probe_catalog.add";
export const REMOVE = "probe_catalog.remove";
export const RUN = "probe_catalog.run";
export const PROVIDER = "fake";
export const FIRST_TARGET = "one";

/** The graph every run sends. */
const GRAPH = {
  "1": { class_type: "LoadImage", inputs: { image: "in.png" } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
};

const TARGET_PARAM = {
  target: { type: "string", required: true, description: "The entry's target." },
} as const;

/** An operation of this fixture with the fields they share. */
function operation(
  name: string,
  description: string,
  execute: OperationSpec["execute"],
): OperationSpec {
  return {
    name,
    component: COMPONENT,
    version: "1",
    description: `${description} Exists only in the integration test.`,
    params: TARGET_PARAM,
    inputs: {},
    outputs: [],
    deterministic: false,
    resource: "none",
    summarize: (record) => `${name} ${String(record.params["target"])}`,
    execute,
  };
}

export const inject = ["csProject", "csCatalog"];

export function apply(ctx: Context): void {
  /** The removers of the entries that `probe_catalog.add` registered, by target. */
  const added = new Map<string, () => void>();

  ctx.effect(() => ctx.csProject.registerComponent(COMPONENT));
  ctx.effect(() => ctx.csCatalog.register(fakeGraphEntry({ target: FIRST_TARGET, lookups: true })));
  ctx.effect(() => () => {
    for (const remove of added.values()) remove();
    added.clear();
  });

  ctx.effect(() =>
    ctx.csProject.registerOperation(
      operation(ADD, "Register one more fake entry.", (context) => {
        const target = String(context.params["target"]);
        added.set(target, ctx.csCatalog.register(fakeGraphEntry({ target })));
        return Promise.resolve({ outputs: [] });
      }),
    ),
  );
  ctx.effect(() =>
    ctx.csProject.registerOperation(
      operation(REMOVE, "Remove a fake entry that was added.", (context) => {
        const target = String(context.params["target"]);
        added.get(target)?.();
        added.delete(target);
        return Promise.resolve({ outputs: [] });
      }),
    ),
  );
  ctx.effect(() =>
    ctx.csProject.registerOperation(
      operation(RUN, "Run a graph on a fake entry.", async (context) => {
        const target = String(context.params["target"]);
        const entry = ctx.csCatalog.get({ primitive: "graph", provider: PROVIDER, target });
        if (entry === undefined) throw new Error(`No entry graph/${PROVIDER}/${target}.`);
        const kinds: string[] = [];
        let run: string | null = null;
        let files = 0;
        const events = entry.run(
          { graph: GRAPH, media: [] },
          { dir: context.scratchDir, assets: ctx.csProject.assets(), signal: context.signal },
        );
        for await (const event of events) {
          kinds.push(event.kind);
          if (event.kind === "queued") run = event.run;
          if (event.kind === "output") files += 1;
        }
        // No asset store is mounted in this profile yet, so the files are counted, not imported.
        return { outputs: [], report: { run, kinds, files } };
      }),
    ),
  );
}
