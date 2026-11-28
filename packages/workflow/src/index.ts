/**
 * The workflow feature component as the `csWorkflow` Cordis service. It registers the `workflow` component with its
 * reducer and operations, and gives the components that run workflows (generation, 2-3d) two things: `resolve`, which
 * reads a workflow and its graph from a project's state, and `objectInfo`, the node catalog of the place a workflow
 * would run. The catalog service `csCatalog` is optional: without it the graph checks are structural only.
 *
 * @module @cs/workflow
 */
import { parseObjectInfo, type ApiGraph, type ObjectInfo } from "@cs/comfy/workflow";
import { servesPrimitive } from "@cs/catalog";
import { ProjectError } from "@cs/project";
import type { ProjectState, RecordId } from "@cs/project/types";
import { Service, type Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { readGraph } from "./files.ts";
import { workflowOperations } from "./operations.ts";
import { workflowReducer } from "./reducer.ts";
import {
  WORKFLOW_COMPONENT,
  WORKFLOW_LIMITS,
  type WorkflowItem,
  type WorkflowTarget,
} from "./types.ts";

export * from "./types.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The workflow feature component: the project's workflows and the node catalog of the places they run. */
    csWorkflow: CsWorkflow;
  }
}

/** `csWorkflow` plugin configuration: none. */
export type Config = object;

/** Loader validation. */
export const Config: z<Config> = z.object({});

/**
 * @param promise - a pending answer.
 * @param ms - how long to wait for it.
 * @param signal - a signal that ends the wait early.
 * @returns the answer.
 * @throws Error when the time passes or the signal aborts first.
 */
function within<T>(promise: Promise<T>, ms: number, signal: AbortSignal | undefined): Promise<T> {
  const { promise: stop, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    reject(new Error(`no answer within ${String(ms)} ms`));
  }, ms);
  const onAbort = (): void => {
    reject(new Error("aborted"));
  };
  if (signal?.aborted === true) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, stop]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}

/** The workflow feature component. */
export default class CsWorkflow extends Service {
  static inject = ["csProject"];
  static Config = Config;

  constructor(ctx: Context, _config: Config) {
    super(ctx, "csWorkflow");
    ctx.effect(() => ctx.csProject.registerComponent(WORKFLOW_COMPONENT), "csWorkflow component");
    ctx.effect(
      () => ctx.csProject.registerReducer(WORKFLOW_COMPONENT, workflowReducer),
      "csWorkflow reducer",
    );
    const assets = ctx.csProject.assets();
    const specs = workflowOperations({
      read: (asset) => assets.read(asset),
      has: (asset) => assets.has(asset),
      facts: (asset) => assets.get(asset),
      stateOf: (project) => ctx.csProject.getState(project),
      objectInfo: (target, signal) => this.objectInfo(target, signal),
    });
    for (const spec of specs) {
      ctx.effect(() => ctx.csProject.registerOperation(spec), `csWorkflow ${spec.name}`);
    }
  }

  /**
   * @param state - a project's state.
   * @param id - a workflow's ID.
   * @returns the workflow and its graph, read from the graph's blob.
   * @throws ProjectError `invalid_params` when the project has no such workflow.
   */
  resolve(state: ProjectState, id: RecordId): { item: WorkflowItem; graph: ApiGraph } {
    const items = state.components.workflow?.items;
    const item = items !== undefined && Object.hasOwn(items, id) ? items[id] : undefined;
    if (item === undefined) {
      throw new ProjectError("invalid_params", `Unknown workflow '${String(id)}'.`);
    }
    return { item, graph: readGraph(this.ctx.csProject.assets().read(item.graph)) };
  }

  /**
   * @param target - the catalog `graph` entry a workflow runs on; null to use the only `graph` entry, if there is
   *   exactly one.
   * @param signal - ends the wait early.
   * @returns the entry's node catalog, or undefined when there is no such entry, it has no node catalog, or it does
   *   not answer within `WORKFLOW_LIMITS.nodeCatalogWaitMs`.
   */
  async objectInfo(
    target: WorkflowTarget | null,
    signal?: AbortSignal,
  ): Promise<ObjectInfo | undefined> {
    const catalog = this.ctx.get("csCatalog");
    if (catalog === undefined) return undefined;
    const entries = catalog
      .list({ primitive: "graph" })
      .filter((entry) => servesPrimitive(entry, ["graph"]));
    const entry =
      target === null
        ? entries.length === 1
          ? entries[0]
          : undefined
        : catalog.get({ primitive: "graph", provider: target.provider, target: target.target });
    if (
      entry === undefined ||
      !servesPrimitive(entry, ["graph"]) ||
      entry.nodeCatalog === undefined
    ) {
      return undefined;
    }
    try {
      const body = await within(entry.nodeCatalog(), WORKFLOW_LIMITS.nodeCatalogWaitMs, signal);
      return parseObjectInfo(body);
    } catch (error) {
      this.ctx
        .logger("csWorkflow")
        .warn(
          `The node catalog of ${entry.provider}/${entry.target} is not available: ${error instanceof Error ? error.message : String(error)}`,
        );
      return undefined;
    }
  }
}
