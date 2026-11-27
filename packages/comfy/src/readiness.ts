import type { ComfyServerKind } from "./types.ts";
import { isModelLoaderInput, mergeModelFiles } from "./model-loaders.ts";
import {
  inputSpecOptions,
  nodeClasses,
  type ApiGraph,
  type InputSpec,
  type ObjectInfo,
} from "./workflow.ts";

/**
 * Whether a template can run on a server, judged against the server's node catalog: node
 * classes the server does not have, and model files a loader names that the server does not
 * list. Pure logic, shared by the service, the tool and the badges.
 *
 * Nothing here maps one server's model names to another's: the result only points at what is
 * missing, and the agent proposes a `propose_graph_patch` with a file the server does list.
 */

/** One model-loader input of the graph and the file it names. */
export interface ModelFileRef {
  nodeId: string;
  input: string;
  file: string;
}

export interface Readiness {
  /** Node classes in the graph that the server's catalog lacks, in graph order. */
  missingNodes: string[];
  /** Loader inputs whose file is not among the choices the server lists for that input. */
  missingModels: ModelFileRef[];
  /**
   * Loader inputs whose choices the catalog does not list (no spec, not a choice input, or an
   * empty list), so presence cannot be told. They do not make `ready` false.
   */
  unverifiable: ModelFileRef[];
  /** No missing node and no missing model. */
  ready: boolean;
}

/** One enabled server's readiness for a workflow; `null` when its catalog could not be read. */
export interface ServerReadiness {
  serverId: string;
  serverName: string;
  kind: ComfyServerKind;
  /**
   * Names of the model families the template's base models are taken to be on this server
   * (`familiesOfGraph`); files of an unknown family are left out.
   */
  families: string[];
  readiness: Readiness | null;
}

function specOf(catalog: ObjectInfo, classType: string, input: string): InputSpec | undefined {
  const info = catalog[classType];
  const spec = info?.input?.required?.[input] ?? info?.input?.optional?.[input];
  return Array.isArray(spec) ? spec : undefined;
}

/**
 * Checks `graph` against `catalog` (a server's whole `/object_info`). `modelLibrary` (files per
 * model folder, as `ComfyClient.modelLibrary()` returns) is merged into the loaders' choices
 * first, for a catalog that does not already include it. Linked loader inputs are skipped, and
 * so are loader nodes whose class is missing (the node is already reported).
 */
export function workflowReadiness(
  graph: ApiGraph,
  catalog: ObjectInfo,
  modelLibrary?: ReadonlyMap<string, string[]>,
): Readiness {
  const missingNodes = nodeClasses(graph).filter((c) => !catalog[c]);
  const choices = modelLibrary ? mergeModelFiles(catalog, modelLibrary) : catalog;
  const missingModels: ModelFileRef[] = [];
  const unverifiable: ModelFileRef[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    if (!catalog[node.class_type]) continue;
    for (const [input, value] of Object.entries(node.inputs)) {
      if (!isModelLoaderInput(node.class_type, input)) continue;
      if (typeof value !== "string" || !value.trim()) continue;
      const ref = { nodeId, input, file: value };
      const spec = specOf(choices, node.class_type, input);
      const options = spec ? inputSpecOptions(spec) : undefined;
      if (!options || options.length === 0) unverifiable.push(ref);
      else if (!options.includes(value)) missingModels.push(ref);
    }
  }
  return {
    missingNodes,
    missingModels,
    unverifiable,
    ready: missingNodes.length === 0 && missingModels.length === 0,
  };
}
