/**
 * The nine operations of the workflow component, built over the host's view of the asset store and the catalog
 * (`OperationDeps`). A workflow is a template: its graph lives as a JSON blob in the asset store and is never
 * changed in place; the only way to a changed graph is a graph patch saved as a new variant. Each `precondition`
 * does every check that needs no server and refuses before a record is written; the checks that use a server's node
 * catalog run in `execute` and in `workflow.check_patch`.
 *
 * @module @cs/workflow/operations
 */
import type { ApiGraph, ObjectInfo, WorkflowParam } from "@cs/comfy/workflow";
import { hasErrors } from "@cs/comfy/graph-patch";
import { OperationFailure, ProjectError } from "@cs/project";
import type { OperationSpec } from "@cs/project";
import type {
  AssetId,
  OperationContext,
  ProjectId,
  ProjectRecord,
  ProjectState,
  RecordId,
  RunRequest,
} from "@cs/project/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import { z as zod } from "zod";
import {
  applyPatch,
  canonicalGraph,
  checkDescription,
  checkFields,
  checkName,
  checkPinnedDefaults,
  nameFromFile,
  parseGraphFile,
  parsePatch,
  problemLines,
  readGraph,
  suggestedFields,
  trimField,
  variantFields,
} from "./files.ts";
import { getReport, graphReport, listReport, patchReport } from "./read.ts";
import { emptySlice } from "./reducer.ts";
import { OPERATION_LABELS } from "./strings.ts";
import {
  WORKFLOW_COMPONENT,
  WORKFLOW_LIMITS,
  WORKFLOW_OPERATIONS,
  type WorkflowItem,
  type WorkflowMadeReport,
  type WorkflowSlice,
  type WorkflowTarget,
} from "./types.ts";

/** What the operations need from the host. */
export interface OperationDeps {
  /** The bytes of an asset the store holds; throws ProjectError `unknown_asset`. */
  read(asset: AssetId): Uint8Array;
  /** Whether the store holds the asset; lets a check skip reading the bytes. Absent: the check reads them. */
  has?(asset: AssetId): boolean;
  /** The media type and display name of an asset; throws ProjectError `unknown_asset`. */
  facts(asset: AssetId): { mime: string; name: string; size_bytes?: number };
  /** The current state of another project; throws ProjectError `unknown_project`. */
  stateOf(project: ProjectId): ProjectState;
  /** The node catalog of the place a workflow would run, or undefined when there is none or it did not answer in time. */
  objectInfo(target: WorkflowTarget | null, signal?: AbortSignal): Promise<ObjectInfo | undefined>;
}

const recordId = zod.string().transform((value) => brandString<RecordId>(value));
const projectId = zod.string().transform((value) => brandString<ProjectId>(value));
const targetSchema = zod.object({
  provider: zod.string().min(1).max(200),
  target: zod.string().min(1).max(200),
});

const createParams = zod.object({
  name: zod.string().optional(),
  description: zod.string().optional(),
  target: targetSchema.nullish(),
});
const updateParams = zod.object({
  workflow: recordId,
  name: zod.string().optional(),
  description: zod.string().optional(),
  fields: zod.unknown().optional(),
  target: targetSchema.nullable().optional(),
});
const variantParams = zod.object({
  workflow: recordId,
  ops: zod.unknown(),
  name: zod.string(),
  description: zod.string().optional(),
});
const copyParams = zod.object({ project: projectId, workflow: recordId });
const workflowParams = zod.object({ workflow: recordId });
const listParams = zod.object({ q: zod.string().optional() });
const graphParams = zod.object({ workflow: recordId, nodes: zod.array(zod.string()).optional() });
const checkParams = zod.object({
  workflow: recordId,
  ops: zod.unknown(),
  target: targetSchema.nullish(),
});

/**
 * @param schema - a zod schema.
 * @param params - a call's params.
 * @returns the parsed params.
 * @throws ProjectError `invalid_params` when they do not parse; the message names the first problem.
 */
function parseParams<T>(schema: zod.ZodType<T>, params: Record<string, unknown>): T {
  const parsed = schema.safeParse(params);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : ` (${issue.path.join(".")})`;
  throw new ProjectError("invalid_params", `The parameters are not valid${where}.`);
}

/**
 * @param state - the project state.
 * @returns the workflow slice, empty while it is absent.
 */
function sliceOf(state: ProjectState): WorkflowSlice {
  return state.components.workflow ?? emptySlice();
}

/**
 * @param slice - the workflows.
 * @param id - a workflow ID a call names.
 * @returns the workflow.
 * @throws ProjectError `invalid_params` when there is no such workflow.
 */
function requireItem(slice: WorkflowSlice, id: RecordId): WorkflowItem {
  const item = Object.hasOwn(slice.items, id) ? slice.items[id] : undefined;
  if (item === undefined) {
    throw new ProjectError("invalid_params", `Unknown workflow '${String(id)}'.`);
  }
  return item;
}

/**
 * @param request - a call.
 * @param state - the project's current state, to find the output a `{record, output}` input names.
 * @returns the asset of the call's `file` input.
 * @throws ProjectError `invalid_inputs` when the call names no file.
 */
function fileAsset(request: RunRequest, state: ProjectState): AssetId {
  let named = false;
  for (const input of request.inputs) {
    if (input.role !== "file") continue;
    named = true;
    const ref = input.ref;
    if ("asset" in ref) return ref.asset;
    if ("record" in ref) {
      const producer = state.components.proj.records.find((record) => record.id === ref.record);
      const output = producer?.outputs[ref.output];
      if (output !== undefined) return output;
    }
  }
  throw new ProjectError(
    "invalid_inputs",
    named
      ? "The `file` input's reference could not be resolved to a file; pass the asset ID that the upload returned."
      : "Give the graph file as the `file` input.",
  );
}

/**
 * @param item - a workflow.
 * @param deps - the host.
 * @returns the workflow's graph, read from its blob.
 * @throws ProjectError `unknown_asset` or `invalid_inputs`.
 */
function graphOf(item: WorkflowItem, deps: OperationDeps): ApiGraph {
  return readGraph(deps.read(item.graph));
}

/**
 * @param fields - fields as the reducer should keep them.
 * @returns the fields without their long choice lists.
 */
function trimmed(fields: WorkflowParam[]): WorkflowParam[] {
  return fields.map(trimField);
}

/**
 * @param problems - the lines of a graph check.
 * @returns the lines as one sentence of a refusal or failure.
 */
function joined(lines: string[]): string {
  return lines.join("; ");
}

/** @returns the text of a record's report entry when it is a string. */
function reportText(record: ProjectRecord, key: string): string | null {
  const value = record.report?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * @param record - a finished operation record.
 * @param fallback - the name used when the record has no report.
 * @returns the quoted name of the workflow a made-report names.
 */
function quotedName(record: ProjectRecord, fallback: string): string {
  return `"${reportText(record, "name") ?? fallback}"`;
}

/** The fields every operation of the component shares. */
const BASE = {
  component: WORKFLOW_COMPONENT,
  version: "1",
  resource: "none",
  deterministic: false,
} as const;

/** The `workflow` param that names a workflow. */
const WORKFLOW_PARAM = {
  type: "string",
  required: true,
  description: "The workflow's ID, from the project summary (`workflows`) or cs_workflow_list.",
} as const;

/** The shape of a catalog `graph` entry's key. */
const TARGET_SPEC = {
  type: "object",
  properties: {
    provider: { type: "string", required: true, description: "The catalog entry's provider." },
    target: { type: "string", required: true, description: "The catalog entry's target." },
  },
  additionalProperties: false,
  description: "A place to run on: the provider and target of a catalog `graph` entry.",
} as const;

/** The `ops` param of the patch operations. */
const OPS_SPEC = {
  type: "array",
  required: true,
  items: {
    type: "object",
    properties: { op: { type: "string", enum: ["set", "link", "add", "remove"], required: true } },
    additionalProperties: true,
  },
  description: "The patch: 1 to 100 operations, applied in order.",
} as const;

/** The operation shapes an agent needs to write a patch. */
const PATCH_SHAPES =
  'Patch ops: {op:"set",node,input,value}; {op:"link",node,input,from:{node,output}}; ' +
  '{op:"add",id?,class_type,title?,inputs?}; {op:"remove",node}. Node IDs are strings.';

/**
 * @param deps - what the host provides.
 * @returns the operations of the workflow component, to register with `csProject.registerOperation`.
 */
export function workflowOperations(deps: OperationDeps): OperationSpec[] {
  const create: OperationSpec = {
    ...BASE,
    name: WORKFLOW_OPERATIONS.create,
    label: OPERATION_LABELS.create,
    description:
      "Make a workflow from an uploaded ComfyUI graph file: API-format JSON, or a PNG that ComfyUI saved with its " +
      "prompt. Only the user does this, in the app; agents have no tool for it.",
    params: {
      name: {
        type: "string",
        description: "The name; the file name without its extension if absent.",
      },
      description: { type: "string", description: "What the workflow is for." },
      target: { ...TARGET_SPEC, description: "The place to run on by default." },
    },
    inputs: {
      file: {
        type: "any",
        description: "The uploaded graph file, by asset ID.",
        required: true,
      },
    },
    outputs: [],
    agent: "none",
    summarize: (record) => {
      const fields = record.report?.["fields"];
      const nodes = record.report?.["nodes"];
      return `made workflow ${quotedName(record, "")} (${String(typeof nodes === "number" ? nodes : 0)} nodes, ${String(Array.isArray(fields) ? fields.length : 0)} fields)`;
    },
    precondition(request, state) {
      const params = parseParams(createParams, request.params);
      if (params.name !== undefined) checkName(params.name);
      checkDescription(params.description);
      const asset = fileAsset(request, state);
      const facts = deps.facts(asset);
      if (facts.size_bytes !== undefined && facts.size_bytes > WORKFLOW_LIMITS.fileBytes) {
        throw new ProjectError(
          "invalid_inputs",
          `The graph file is larger than ${String(WORKFLOW_LIMITS.fileBytes / (1024 * 1024))} MiB.`,
        );
      }
      parseGraphFile(deps.read(asset), facts.mime);
      return Promise.resolve();
    },
    async execute(context) {
      const params = parseParams(createParams, context.params);
      const file = context.inputs.find((input) => input.role === "file")?.resolved_asset ?? null;
      if (file === null) throw new Error("The file input has no asset.");
      const facts = deps.facts(file);
      const parsed = parseGraphFile(deps.read(file), facts.mime);
      const name = params.name === undefined ? nameFromFile(facts.name) : checkName(params.name);
      const info = await deps.objectInfo(params.target ?? null, context.signal);
      // A stop during the wait makes `objectInfo` answer nothing; the call must end, not go on without a catalog.
      context.signal.throwIfAborted();
      const graph = context.importAsset(parsed.bytes, {
        mime: "application/json",
        name: `${name}.workflow.json`,
      });
      const made: WorkflowMadeReport = {
        graph,
        fields: trimmed(suggestedFields(parsed.graph, info)),
        nodes: parsed.nodes,
        name,
        description: checkDescription(params.description),
      };
      return { outputs: [], report: { ...made } };
    },
  };

  const update: OperationSpec = {
    ...BASE,
    name: WORKFLOW_OPERATIONS.update,
    label: OPERATION_LABELS.update,
    description:
      "Change a workflow's name, description, exposed form fields or default place to run. Only the user does this, " +
      "in the app; agents have no tool for it. The graph is never changed.",
    params: {
      workflow: WORKFLOW_PARAM,
      name: { type: "string", description: "The new name." },
      description: { type: "string", description: "The new description." },
      fields: { type: "array", items: { type: "json" }, description: "The exposed fields." },
      target: {
        oneOf: [TARGET_SPEC, { type: "null" }],
        description: "The default place to run on, or null to clear it.",
      },
    },
    inputs: {},
    outputs: [],
    agent: "none",
    summarize: () => "updated workflow",
    precondition(request, state) {
      const params = parseParams(updateParams, request.params);
      const item = requireItem(sliceOf(state), params.workflow);
      if (
        params.name === undefined &&
        params.description === undefined &&
        params.fields === undefined &&
        params.target === undefined
      ) {
        throw new ProjectError(
          "invalid_params",
          'Give at least one of "name", "description", "fields" or "target".',
        );
      }
      if (params.name !== undefined) checkName(params.name);
      if (params.description !== undefined) checkDescription(params.description);
      if (params.fields !== undefined) checkFields(graphOf(item, deps), params.fields);
      return Promise.resolve();
    },
    execute(context) {
      const params = parseParams(updateParams, context.params);
      if (params.fields === undefined) return Promise.resolve({ outputs: [] });
      const item = requireItem(sliceOf(context.state), params.workflow);
      const fields = trimmed(checkFields(graphOf(item, deps), params.fields));
      return Promise.resolve({ outputs: [], report: { fields } });
    },
  };

  const saveVariant: OperationSpec = {
    ...BASE,
    name: WORKFLOW_OPERATIONS.saveVariant,
    label: OPERATION_LABELS.saveVariant,
    description:
      "Save a patched copy of a workflow as a new workflow (a variant). Workflows are templates: a graph is never " +
      "edited in place and the original stays as it is. To change one, read it with cs_workflow_graph, test the " +
      "patch with cs_workflow_check_patch, then save it here. " +
      PATCH_SHAPES +
      " At most 100 ops. A patch that makes a broken graph is refused.",
    params: {
      workflow: WORKFLOW_PARAM,
      ops: OPS_SPEC,
      name: {
        type: "string",
        required: true,
        description: "The variant's name, 1 to 100 characters.",
      },
      description: { type: "string", description: "What the variant changes." },
    },
    inputs: {},
    outputs: [],
    agent: "run",
    omitParamsFromResult: true,
    summarize: (record) => `saved variant ${quotedName(record, "")}`,
    precondition(request, state) {
      const params = parseParams(variantParams, request.params);
      const item = requireItem(sliceOf(state), params.workflow);
      checkName(params.name);
      checkDescription(params.description);
      const ops = parsePatch(params.ops);
      const { result, problems } = applyPatch(graphOf(item, deps), ops);
      if (hasErrors(problems))
        throw new ProjectError("invalid_params", joined(problemLines(problems)));
      checkPinnedDefaults(item.fields, result);
      return Promise.resolve();
    },
    async execute(context) {
      const params = parseParams(variantParams, context.params);
      const item = requireItem(sliceOf(context.state), params.workflow);
      const info = await deps.objectInfo(item.target, context.signal);
      context.signal.throwIfAborted();
      const { result, problems } = applyPatch(graphOf(item, deps), parsePatch(params.ops), info);
      if (hasErrors(problems)) {
        throw new OperationFailure("invalid_graph", joined(problemLines(problems)));
      }
      try {
        checkPinnedDefaults(item.fields, result);
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error;
        throw new OperationFailure("invalid_graph", error.message);
      }
      const graph = context.importAsset(canonicalGraph(result.graph), {
        mime: "application/json",
        name: `${checkName(params.name)}.workflow.json`,
      });
      const made: WorkflowMadeReport = {
        graph,
        fields: trimmed(variantFields(item.fields, result, info)),
        nodes: Object.keys(result.graph).length,
        name: checkName(params.name),
        description: checkDescription(params.description),
        ...(problems.length === 0 ? {} : { warnings: problemLines(problems) }),
      };
      return { outputs: [], report: { ...made } };
    },
  };

  /** The workflow a copy call names in the other project. */
  const sourceOf = (params: zod.infer<typeof copyParams>): WorkflowItem => {
    const other = sliceOf(deps.stateOf(params.project));
    const item = Object.hasOwn(other.items, params.workflow)
      ? other.items[params.workflow]
      : undefined;
    if (item === undefined) {
      throw new ProjectError(
        "invalid_params",
        `Project ${String(params.project)} has no workflow '${String(params.workflow)}'.`,
      );
    }
    return item;
  };

  const copy: OperationSpec = {
    ...BASE,
    name: WORKFLOW_OPERATIONS.copy,
    label: OPERATION_LABELS.copy,
    description:
      "Copy a workflow of another project into this one. Only the user does this, in the app; agents have no " +
      "tool for it. The copy has no parent and no default place to run.",
    params: {
      project: { type: "string", required: true, description: "The other project's ID." },
      workflow: {
        type: "string",
        required: true,
        description: "The workflow's ID in that project.",
      },
    },
    inputs: {},
    outputs: [],
    agent: "none",
    summarize: (record) => `copied workflow ${quotedName(record, "")}`,
    precondition(request) {
      const params = parseParams(copyParams, request.params);
      if (params.project === request.project) {
        throw new ProjectError(
          "invalid_params",
          "Copy from another project; this workflow is already here.",
        );
      }
      const source = sourceOf(params).graph;
      // Only the existence matters here; `execute` reads the bytes.
      if (deps.has === undefined) deps.read(source);
      else if (!deps.has(source)) {
        throw new ProjectError("unknown_asset", `Unknown asset ${String(source)}.`);
      }
      return Promise.resolve();
    },
    execute(context) {
      const params = parseParams(copyParams, context.params);
      const item = sourceOf(params);
      const graph = context.importAsset(deps.read(item.graph), {
        mime: "application/json",
        name: `${item.name}.workflow.json`,
      });
      const made: WorkflowMadeReport = {
        graph,
        fields: item.fields,
        nodes: item.nodes,
        name: item.name,
        description: item.description,
      };
      return Promise.resolve({ outputs: [], report: { ...made } });
    },
  };

  const remove: OperationSpec = {
    ...BASE,
    name: WORKFLOW_OPERATIONS.delete,
    label: OPERATION_LABELS.delete,
    description:
      "Propose deleting a workflow. Your call writes a proposal and nothing is deleted until the user accepts it. " +
      "Variants made from it stay and lose their parent. Undo brings the workflow back.",
    params: { workflow: WORKFLOW_PARAM },
    inputs: {},
    outputs: [],
    agent: "propose",
    summarize: () => "deleted workflow",
    precondition(request, state) {
      requireItem(sliceOf(state), parseParams(workflowParams, request.params).workflow);
      return Promise.resolve();
    },
    execute: () => Promise.resolve({ outputs: [] }),
  };

  const list: OperationSpec = {
    ...BASE,
    name: WORKFLOW_OPERATIONS.list,
    label: OPERATION_LABELS.list,
    description:
      "List the project's workflows with their IDs, names, descriptions, node and field counts and parents. " +
      "Param `q` keeps the workflows whose name or description contains every word of it.",
    params: { q: { type: "string", description: "Words to search names and descriptions for." } },
    inputs: {},
    outputs: [],
    readOnly: true,
    summarize: () => "listed workflows",
    precondition(request) {
      parseParams(listParams, request.params);
      return Promise.resolve();
    },
    execute(context) {
      const params = parseParams(listParams, context.params);
      return Promise.resolve({
        outputs: [],
        report: { ...listReport(sliceOf(context.state), params.q) },
      });
    },
  };

  const get: OperationSpec = {
    ...BASE,
    name: WORKFLOW_OPERATIONS.get,
    label: OPERATION_LABELS.get,
    description:
      "Read one workflow: name, description, exposed form fields (ID, label, kind, default, range, choices), the " +
      "default place to run, its parent and its variants. Use cs_workflow_graph to read the graph itself.",
    params: { workflow: WORKFLOW_PARAM },
    inputs: {},
    outputs: [],
    readOnly: true,
    summarize: () => "read a workflow",
    precondition(request, state) {
      requireItem(sliceOf(state), parseParams(workflowParams, request.params).workflow);
      return Promise.resolve();
    },
    execute(context) {
      const params = parseParams(workflowParams, context.params);
      return Promise.resolve({
        outputs: [],
        report: { ...getReport(sliceOf(context.state), params.workflow) },
      });
    },
  };

  const graph: OperationSpec = {
    ...BASE,
    name: WORKFLOW_OPERATIONS.graph,
    label: OPERATION_LABELS.graph,
    description:
      "Read a workflow's graph as text, one line per node with its class, inputs and links. A graph too long for one " +
      "answer comes back as an outline of node IDs by class; then read parts of it with `nodes`, a list of node " +
      "IDs. Read the graph before you write a patch.",
    params: {
      workflow: WORKFLOW_PARAM,
      nodes: { type: "array", items: { type: "string" }, description: "Only these node IDs." },
    },
    inputs: {},
    outputs: [],
    readOnly: true,
    summarize: () => "read a workflow graph",
    precondition(request, state) {
      requireItem(sliceOf(state), parseParams(graphParams, request.params).workflow);
      return Promise.resolve();
    },
    execute(context) {
      const params = parseParams(graphParams, context.params);
      const item = requireItem(sliceOf(context.state), params.workflow);
      return Promise.resolve({
        outputs: [],
        report: { ...graphReport(item.id, graphOf(item, deps), params.nodes) },
      });
    },
  };

  const checkPatch: OperationSpec = {
    ...BASE,
    name: WORKFLOW_OPERATIONS.checkPatch,
    label: OPERATION_LABELS.checkPatch,
    description:
      "Try a graph patch on a workflow without saving anything. It answers whether the patch applies, the problems " +
      "the patch would newly make, the nodes it adds and removes, and the changed nodes as text. " +
      PATCH_SHAPES +
      " Optional `target` names the place whose node catalog checks classes and links.",
    params: {
      workflow: WORKFLOW_PARAM,
      ops: OPS_SPEC,
      target: TARGET_SPEC,
    },
    inputs: {},
    outputs: [],
    readOnly: true,
    omitParamsFromResult: true,
    summarize: () => "checked a graph patch",
    precondition(request, state) {
      requireItem(sliceOf(state), parseParams(checkParams, request.params).workflow);
      return Promise.resolve();
    },
    async execute(context: OperationContext) {
      const params = parseParams(checkParams, context.params);
      const item = requireItem(sliceOf(context.state), params.workflow);
      const info = await deps.objectInfo(params.target ?? item.target, context.signal);
      return {
        outputs: [],
        report: { ...patchReport(item.id, graphOf(item, deps), params.ops, info) },
      };
    },
  };

  return [create, update, saveVariant, copy, remove, list, get, graph, checkPatch];
}
