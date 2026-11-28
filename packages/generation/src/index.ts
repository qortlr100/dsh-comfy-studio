/**
 * The generation feature component as the `csGeneration` Cordis service. It registers the `gen` component with its
 * reducer and its settings and read operations, and `gen.run` while the catalog holds a `graph` entry: a workflow runs
 * on one entry, the outputs enter the project as assets, and the asset library holds them for review. The design is
 * `docs/archive/PLAN_2-3d.md`.
 *
 * @module @cs/generation
 */
import { servesPrimitive } from "@cs/catalog";
import type {} from "@cs/workflow";
import { ProjectError } from "@cs/project";
import type { AssetId } from "@cs/project/types";
import { Service, type Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { otherOperations, runOperation, type OperationDeps } from "./operations.ts";
import { genReducer } from "./reducer.ts";
import { GEN_COMPONENT, type GenTargetEntry } from "./types.ts";

export * from "./types.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The generation feature component: runs a project's workflows on the catalog's `graph` entries. */
    csGeneration: CsGeneration;
  }
}

/** `csGeneration` plugin configuration: none. */
export type Config = object;

/** Loader validation. */
export const Config: z<Config> = z.object({});

/** The generation feature component. */
export default class CsGeneration extends Service {
  static inject = ["csProject", "csWorkflow", "csCatalog"];
  static Config = Config;

  constructor(ctx: Context, _config: Config) {
    super(ctx, "csGeneration");
    ctx.effect(() => ctx.csProject.registerComponent(GEN_COMPONENT), "csGeneration component");
    ctx.effect(
      () => ctx.csProject.registerReducer(GEN_COMPONENT, genReducer),
      "csGeneration reducer",
    );
    const deps: OperationDeps = {
      workflow: (state, id) => ctx.csWorkflow.resolve(state, id),
      entry: (target, fallback) => {
        const key = target ?? fallback;
        if (key !== null) {
          const entry = ctx.csCatalog.get({
            primitive: "graph",
            provider: key.provider,
            target: key.target,
          });
          if (entry === undefined) {
            throw new ProjectError(
              "invalid_params",
              `There is no place to run called ${key.provider}/${key.target}. Call cs_gen_targets to see the places and pass one as 'target'.`,
            );
          }
          return entry;
        }
        const entries = ctx.csCatalog
          .list({ primitive: "graph" })
          .filter((entry) => servesPrimitive(entry, ["graph"]));
        const [only, ...rest] = entries;
        if (only === undefined || rest.length > 0 || !servesPrimitive(only, ["graph"])) {
          throw new ProjectError(
            "invalid_params",
            entries.length === 0
              ? "There is no place to run on. Call cs_gen_targets to see the places."
              : "This workflow has no default place to run and there is more than one. Call cs_gen_targets and pass one as 'target'.",
          );
        }
        return only;
      },
      targets: async () => {
        const summary = await ctx.csCatalog.summary();
        return summary
          .filter((item) => item.primitive === "graph")
          .map((item): GenTargetEntry => ({
            provider: item.provider,
            target: item.target,
            label: item.facts?.label ?? null,
            kind: item.facts?.kind ?? null,
            description: item.description,
            problem: item.problem,
          }));
      },
      assets: () => ctx.csProject.assets(),
      mimeOf: (asset: AssetId) => {
        const assets = ctx.csProject.assets();
        if (!assets.has(asset)) {
          throw new ProjectError("unknown_asset", `Unknown asset ${String(asset).slice(0, 8)}.`);
        }
        return assets.get(asset).mime;
      },
    };
    for (const spec of otherOperations(deps)) {
      ctx.effect(() => ctx.csProject.registerOperation(spec), `csGeneration ${spec.name}`);
    }
    // `gen.run` exists only while the catalog can run a graph.
    ctx.effect(
      () =>
        ctx.csCatalog.whileServing(["graph"], () =>
          ctx.csProject.registerOperation(runOperation(deps)),
        ),
      "csGeneration gen.run",
    );
  }
}
