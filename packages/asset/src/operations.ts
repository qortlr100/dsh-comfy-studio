/**
 * The nine operations of the asset component, built over the host's view of the store (`OperationDeps`). Only
 * `asset.import` does work of its own; the others record a change that the reducer applies. Each `precondition`
 * refuses a call that would not make sense before any record is written.
 *
 * @module @cs/asset/operations
 */
import { ProjectError } from "@cs/project";
import type { OperationSpec } from "@cs/project";
import type { AssetId, ProjectRecord, ProjectState, RecordId, RunRequest } from "@cs/project/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import { z as zod } from "zod";
import { decodeCursor, listAssets, type AssetListQuery } from "./library.ts";
import { emptySlice, normalizeFolderName, normalizeTag, subtreeOf } from "./reducer.ts";
import { OPERATION_LABELS } from "./strings.ts";
import {
  ASSET_COMPONENT,
  ASSET_LIMITS,
  ASSET_OPERATIONS,
  SETTABLE_REVIEWS,
  type AssetFolder,
  type AssetSlice,
  type StoredAsset,
} from "./types.ts";

/** What the operations need from the host. */
export interface OperationDeps {
  /** The store's entry of an asset; undefined when no project folder holds it. */
  entry(asset: AssetId): StoredAsset | undefined;
  /** The absolute path of the asset's bytes; throws ProjectError `unknown_asset`. */
  path(asset: AssetId): string;
  /** The URL that serves the asset. */
  url(asset: AssetId): string;
  /** The agent tool name of a registered operation; null for an unknown operation or one that has no agent tool. */
  toolOf(operation: string): string | null;
}

const recordId = zod.string().transform((value) => brandString<RecordId>(value));

const reviewParams = zod.object({ review: zod.enum(SETTABLE_REVIEWS) });
const moveParams = zod.object({ folder: recordId.nullish() });
const tagParams = zod.object({
  add: zod.array(zod.string()).optional(),
  remove: zod.array(zod.string()).optional(),
});
const folderCreateParams = zod.object({ name: zod.string(), parent: recordId.nullish() });
const folderUpdateParams = zod.object({
  folder: recordId,
  name: zod.string().optional(),
  parent: recordId.nullable().optional(),
});
const folderDeleteParams = zod.object({ folder: recordId });
const listParams = zod.object({
  folder: zod.string().optional(),
  review: zod.enum(["pending", "adopted", "held"]).optional(),
  kind: zod.enum(["image", "video", "audio", "file"]).optional(),
  q: zod.string().optional(),
  tags: zod.array(zod.string()).optional(),
  limit: zod.number().optional(),
  cursor: zod.string().optional(),
});

/**
 * @param schema - a zod schema.
 * @param params - a call's params.
 * @returns the parsed params.
 * @throws ProjectError `invalid_params` when they do not parse.
 */
function parseParams<T>(schema: zod.ZodType<T>, params: Record<string, unknown>): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new ProjectError("invalid_params", "The parameters are not valid.");
  return parsed.data;
}

/**
 * @param count - a count.
 * @param noun - a singular noun.
 * @returns the count with the noun, plural when it is not one.
 */
function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * @param request - a call.
 * @param state - the project's current state, to find the outputs a `{record, output}` input names.
 * @param role - an input role.
 * @returns the assets the role's inputs name, without repeats, in order.
 * @throws ProjectError `invalid_inputs` for a reference this function cannot resolve against the current history (a
 *   step outside it, such as an import record or an undone step, an output the step does not have, or a version
 *   reference). The runner resolves such references through the record store, so letting them pass unchecked would
 *   bypass the preconditions.
 */
function inputsOf(request: RunRequest, state: ProjectState, role: string): AssetId[] {
  const found = new Set<AssetId>();
  for (const input of request.inputs) {
    if (input.role !== role) continue;
    const ref = input.ref;
    if ("asset" in ref) {
      found.add(ref.asset);
    } else if ("record" in ref) {
      const producer = state.components.proj.records.find((record) => record.id === ref.record);
      const output = producer?.outputs[ref.output];
      if (output === undefined) throw unresolvable();
      found.add(output);
    } else {
      throw unresolvable();
    }
  }
  return [...found];
}

/** @returns the refusal for an input reference that names no asset of the current history. */
function unresolvable(): ProjectError {
  return new ProjectError(
    "invalid_inputs",
    "An input does not name an asset this call can check. Name assets by asset ID (from cs_asset_list), or by " +
      "<record>#<n> of a step in the current history.",
  );
}

/**
 * @param slice - the library.
 * @param assets - assets a call names.
 * @throws ProjectError `invalid_inputs` when one is not in the library.
 */
function requireInLibrary(slice: AssetSlice, assets: AssetId[]): void {
  const missing = assets.filter((asset) => slice.items[asset] === undefined);
  if (missing.length === 0) return;
  const first = String(missing[0]).slice(0, 8);
  throw new ProjectError(
    "invalid_inputs",
    missing.length === 1
      ? `Asset ${first} is not in this project's asset library.`
      : `${String(missing.length)} of the assets (for example ${first}) are not in this project's asset library.`,
  );
}

/**
 * @param slice - the library.
 * @param folder - a folder ID a call names.
 * @returns the folder.
 * @throws ProjectError `invalid_params` when there is no such folder.
 */
function requireFolder(slice: AssetSlice, folder: RecordId): AssetFolder {
  const found = slice.folders[folder];
  if (found === undefined) {
    throw new ProjectError(
      "invalid_params",
      `There is no asset folder ${String(folder)} in this project.`,
    );
  }
  return found;
}

/**
 * @param folders - the folders.
 * @param folder - a folder, or null for the root.
 * @returns how many folders lie on the path from the root to it, itself included; 0 for the root.
 */
function depthOf(folders: AssetSlice["folders"], folder: RecordId | null): number {
  let depth = 0;
  let current = folder;
  while (current !== null && depth <= ASSET_LIMITS.folderDepth + 1) {
    depth += 1;
    current = folders[current]?.parent ?? null;
  }
  return depth;
}

/**
 * @param folders - the folders.
 * @param folder - a folder.
 * @returns the number of levels the folder and its descendants span; 1 for a folder without subfolders.
 */
function heightOf(folders: AssetSlice["folders"], folder: RecordId): number {
  let height = 1;
  for (const child of Object.values(folders)) {
    if (child.parent === folder) height = Math.max(height, 1 + heightOf(folders, child.id));
  }
  return height;
}

/**
 * @param name - a folder name as a caller wrote it.
 * @returns the name trimmed.
 * @throws ProjectError `invalid_params` for an empty, too long, or slash-bearing name.
 */
function checkFolderName(name: string): string {
  const trimmed = normalizeFolderName(name);
  if (trimmed.length < 1 || trimmed.length > ASSET_LIMITS.folderNameChars) {
    throw new ProjectError(
      "invalid_params",
      `A folder name needs 1 to ${String(ASSET_LIMITS.folderNameChars)} characters.`,
    );
  }
  if (/[/\\]/.test(trimmed)) {
    throw new ProjectError("invalid_params", "A folder name cannot contain / or \\.");
  }
  return trimmed;
}

/**
 * @param slice - the library.
 * @param parent - the parent folder, or null for the root.
 * @param name - the trimmed name.
 * @param except - a folder that does not count, the one being renamed or moved.
 * @throws ProjectError `invalid_params` when a sibling has that name, in any case.
 */
function requireFreeName(
  slice: AssetSlice,
  parent: RecordId | null,
  name: string,
  except: RecordId | null,
): void {
  const lower = name.toLowerCase();
  for (const folder of Object.values(slice.folders)) {
    if (folder.parent === parent && folder.id !== except && folder.name.toLowerCase() === lower) {
      throw new ProjectError(
        "invalid_params",
        `A folder named "${folder.name}" already exists there.`,
      );
    }
  }
}

/**
 * @param tags - tags a call names.
 * @param what - `add` or `remove`.
 * @returns the tags normalized.
 * @throws ProjectError `invalid_params` for too many tags or a tag that is empty, long, or has a comma.
 */
function checkTags(tags: string[], what: string): string[] {
  if (tags.length > ASSET_LIMITS.tagsPerCall) {
    throw new ProjectError(
      "invalid_params",
      `Give at most ${String(ASSET_LIMITS.tagsPerCall)} tags in "${what}".`,
    );
  }
  return tags.map((raw) => {
    const tag = normalizeTag(raw);
    if (tag.length < 1 || tag.length > ASSET_LIMITS.tagChars) {
      throw new ProjectError(
        "invalid_params",
        `A tag needs 1 to ${String(ASSET_LIMITS.tagChars)} characters.`,
      );
    }
    if (tag.includes(","))
      throw new ProjectError("invalid_params", "A tag cannot contain a comma.");
    return tag;
  });
}

/**
 * @param record - a record.
 * @returns how many assets its `asset` inputs name.
 */
function assetCount(record: ProjectRecord): number {
  return new Set(
    record.inputs.filter((input) => input.role === "asset").map((input) => input.resolved_asset),
  ).size;
}

/** The fields every operation of the component shares. */
const BASE = {
  component: ASSET_COMPONENT,
  version: "1",
  resource: "none",
  deterministic: false,
} as const;

/** The `asset` input of the operations that change assets in the library. */
const ASSET_INPUT = {
  asset: {
    type: "any",
    description: "The assets to change, by ID (from cs_asset_list or the project summary).",
    many: true,
    required: true,
  },
} as const;

/**
 * @param state - the project state.
 * @returns the library, empty while the slice is absent.
 */
function libraryOf(state: ProjectState): AssetSlice {
  return state.components.asset ?? emptySlice();
}

/**
 * @param deps - what the host provides.
 * @returns the operations of the asset component, to register with `csProject.registerOperation`.
 */
export function assetOperations(deps: OperationDeps): OperationSpec[] {
  const importAssets: OperationSpec = {
    ...BASE,
    name: ASSET_OPERATIONS.import,
    label: OPERATION_LABELS.import,
    description:
      "Bring files that the asset store already holds into this project's library as adopted assets. " +
      "Only the user does this, outside the undo history, when they upload or pick a file; agents have no tool for it.",
    params: {},
    inputs: {
      file: {
        type: "any",
        description: "The stored files to bring in, by asset ID.",
        many: true,
        required: true,
      },
    },
    outputs: [{ role: "asset", type: "any" }],
    agent: "none",
    outsideHistory: true,
    summarize: (record) => `imported ${counted(record.outputs.length, "asset")}`,
    precondition(request, state) {
      const missing = inputsOf(request, state, "file").filter(
        (asset) => deps.entry(asset) === undefined,
      );
      if (missing.length > 0) {
        throw new ProjectError(
          "invalid_inputs",
          `The file ${String(missing[0]).slice(0, 8)} is not in the asset store.`,
        );
      }
      return Promise.resolve();
    },
    execute(context) {
      const outputs = new Set<AssetId>();
      for (const input of context.inputs) {
        if (input.role !== "file" || input.resolved_asset === null) continue;
        const asset = input.resolved_asset;
        const entry = deps.entry(asset);
        if (entry === undefined) throw new Error(`The file ${asset} is not in the asset store.`);
        outputs.add(
          context.importAsset(
            { path: deps.path(asset) },
            {
              mime: entry.mime,
              name: entry.name,
              ...(entry.duration_sec === null ? {} : { durationSec: entry.duration_sec }),
              ...(entry.width === null ? {} : { width: entry.width }),
              ...(entry.height === null ? {} : { height: entry.height }),
            },
          ),
        );
      }
      return Promise.resolve({ outputs: [...outputs] });
    },
  };

  const review: OperationSpec = {
    ...BASE,
    name: ASSET_OPERATIONS.review,
    label: OPERATION_LABELS.review,
    description:
      "Adopt (keep) or hold (set aside) assets. Assets that operations generate enter the library as pending, and " +
      "only the user decides whether to adopt or hold them; agents have no tool for this.",
    params: {
      review: {
        type: "string",
        enum: SETTABLE_REVIEWS,
        required: true,
        description: "`adopted` keeps the assets; `held` sets them aside.",
      },
    },
    inputs: ASSET_INPUT,
    outputs: [],
    agent: "none",
    summarize: (record) => {
      const state = record.params["review"] === "held" ? "held" : "adopted";
      return `${state} ${counted(assetCount(record), "asset")}`;
    },
    precondition(request, state) {
      parseParams(reviewParams, request.params);
      requireInLibrary(libraryOf(state), inputsOf(request, state, "asset"));
      return Promise.resolve();
    },
    execute: () => Promise.resolve({ outputs: [] }),
  };

  const move: OperationSpec = {
    ...BASE,
    name: ASSET_OPERATIONS.move,
    label: OPERATION_LABELS.move,
    description:
      "File assets into a folder, or into the project root when no folder is given. Folders are the main way to " +
      "organise the library. Param `folder` is a folder ID from the project summary (asset_folders). Inputs are " +
      "asset IDs from cs_asset_list or the project summary.",
    params: {
      folder: {
        type: "string",
        description: "The folder ID to move into; leave out for the project root.",
      },
    },
    inputs: ASSET_INPUT,
    outputs: [],
    agent: "run",
    summarize: (record) =>
      `moved ${counted(assetCount(record), "asset")} to ${record.params["folder"] === undefined ? "the project root" : "a folder"}`,
    precondition(request, state) {
      const params = parseParams(moveParams, request.params);
      requireInLibrary(libraryOf(state), inputsOf(request, state, "asset"));
      if (params.folder !== undefined && params.folder !== null)
        requireFolder(libraryOf(state), params.folder);
      return Promise.resolve();
    },
    execute: () => Promise.resolve({ outputs: [] }),
  };

  const tag: OperationSpec = {
    ...BASE,
    name: ASSET_OPERATIONS.tag,
    label: OPERATION_LABELS.tag,
    description:
      "Add or remove tags on assets. Tags are short lower-case words that make assets easier to find with " +
      "cs_asset_list; folders remain the main way to organise. Params `add` and `remove` take up to 20 tags each " +
      "(1 to 40 characters, no commas); an asset keeps at most 50 tags. Give at least one of them.",
    params: {
      add: { type: "array", items: { type: "string" }, description: "Tags to attach." },
      remove: { type: "array", items: { type: "string" }, description: "Tags to detach." },
    },
    inputs: ASSET_INPUT,
    outputs: [],
    agent: "run",
    summarize: (record) => {
      const parsed = tagParams.safeParse(record.params);
      const add = parsed.success ? (parsed.data.add?.length ?? 0) : 0;
      const remove = parsed.success ? (parsed.data.remove?.length ?? 0) : 0;
      return `tagged ${counted(assetCount(record), "asset")} (${String(add)} added, ${String(remove)} removed)`;
    },
    precondition(request, state) {
      const params = parseParams(tagParams, request.params);
      const assets = inputsOf(request, state, "asset");
      const library = libraryOf(state);
      requireInLibrary(library, assets);
      const add = checkTags(params.add ?? [], "add");
      const remove = checkTags(params.remove ?? [], "remove");
      if (add.length === 0 && remove.length === 0) {
        throw new ProjectError("invalid_params", 'Give at least one tag in "add" or "remove".');
      }
      for (const asset of assets) {
        const removed = new Set(remove);
        const next = new Set(
          (library.items[asset]?.tags ?? []).filter((held) => !removed.has(held)),
        );
        for (const added of add) next.add(added);
        if (next.size > ASSET_LIMITS.tagsPerAsset) {
          throw new ProjectError(
            "invalid_params",
            `An asset keeps at most ${String(ASSET_LIMITS.tagsPerAsset)} tags.`,
          );
        }
      }
      return Promise.resolve();
    },
    execute: () => Promise.resolve({ outputs: [] }),
  };

  const remove: OperationSpec = {
    ...BASE,
    name: ASSET_OPERATIONS.delete,
    label: OPERATION_LABELS.delete,
    description:
      "Propose removing assets from the library. Your call writes a proposal and nothing is removed until the user " +
      "accepts it. The files stay in storage, and undo brings the assets back. Inputs are asset IDs from " +
      "cs_asset_list or the project summary.",
    params: {},
    inputs: ASSET_INPUT,
    outputs: [],
    agent: "propose",
    summarize: (record) => `deleted ${counted(assetCount(record), "asset")}`,
    precondition(request, state) {
      requireInLibrary(libraryOf(state), inputsOf(request, state, "asset"));
      return Promise.resolve();
    },
    execute: () => Promise.resolve({ outputs: [] }),
  };

  const folderCreate: OperationSpec = {
    ...BASE,
    name: ASSET_OPERATIONS.folderCreate,
    label: OPERATION_LABELS.folderCreate,
    description:
      "Create a folder for filing assets. Param `name` is 1 to 100 characters without / or \\ and must differ " +
      "(ignoring case) from its siblings. Param `parent` is the parent folder's ID, or leave it out for the root; " +
      "folders nest at most 4 deep. The new folder's ID is the ID of the record this call writes.",
    params: {
      name: { type: "string", required: true, description: "The folder name." },
      parent: {
        type: "string",
        description: "The parent folder ID; leave out for the project root.",
      },
    },
    inputs: {},
    outputs: [],
    agent: "run",
    summarize: (record) => {
      const name = record.params["name"];
      return `created folder "${typeof name === "string" ? name : ""}"`;
    },
    precondition(request, state) {
      const params = parseParams(folderCreateParams, request.params);
      const library = libraryOf(state);
      const name = checkFolderName(params.name);
      const parent = params.parent ?? null;
      if (parent !== null) requireFolder(library, parent);
      if (depthOf(library.folders, parent) + 1 > ASSET_LIMITS.folderDepth) {
        throw new ProjectError(
          "invalid_params",
          `Folders nest at most ${String(ASSET_LIMITS.folderDepth)} deep.`,
        );
      }
      requireFreeName(library, parent, name, null);
      return Promise.resolve();
    },
    execute: () => Promise.resolve({ outputs: [] }),
  };

  const folderUpdate: OperationSpec = {
    ...BASE,
    name: ASSET_OPERATIONS.folderUpdate,
    label: OPERATION_LABELS.folderUpdate,
    description:
      "Rename a folder or move it under another folder. Param `folder` is the folder's ID. Give `name` to rename. " +
      "Give `parent` as a folder ID to move it there, or as null for the root; a folder cannot move below itself, " +
      "and folders nest at most 4 deep. A moved folder goes last among its new siblings.",
    params: {
      folder: { type: "string", required: true, description: "The folder ID." },
      name: { type: "string", description: "The new name." },
      parent: {
        oneOf: [{ type: "string" }, { type: "null" }],
        description:
          "The new parent folder ID, or null for the project root; leave out to keep it.",
      },
    },
    inputs: {},
    outputs: [],
    agent: "run",
    summarize: (record) => {
      const renamed = record.params["name"] !== undefined;
      const moved = record.params["parent"] !== undefined;
      return renamed && moved
        ? "renamed and moved a folder"
        : moved
          ? "moved a folder"
          : "renamed a folder";
    },
    precondition(request, state) {
      const params = parseParams(folderUpdateParams, request.params);
      const library = libraryOf(state);
      const folder = requireFolder(library, params.folder);
      if (params.name === undefined && params.parent === undefined) {
        throw new ProjectError("invalid_params", 'Give a new "name" or a new "parent".');
      }
      const name = params.name === undefined ? folder.name : checkFolderName(params.name);
      const parent = params.parent === undefined ? folder.parent : params.parent;
      if (parent !== null) {
        requireFolder(library, parent);
        if (subtreeOf(library.folders, folder.id).has(parent)) {
          throw new ProjectError(
            "invalid_params",
            "A folder cannot move into itself or one of its subfolders.",
          );
        }
      }
      if (
        depthOf(library.folders, parent) + heightOf(library.folders, folder.id) >
        ASSET_LIMITS.folderDepth
      ) {
        throw new ProjectError(
          "invalid_params",
          `Folders nest at most ${String(ASSET_LIMITS.folderDepth)} deep, counting the subfolders that move with it.`,
        );
      }
      requireFreeName(library, parent, name, folder.id);
      return Promise.resolve();
    },
    execute: () => Promise.resolve({ outputs: [] }),
  };

  const folderDelete: OperationSpec = {
    ...BASE,
    name: ASSET_OPERATIONS.folderDelete,
    label: OPERATION_LABELS.folderDelete,
    description:
      "Propose deleting a folder together with its subfolders. Your call writes a proposal and nothing changes " +
      "until the user accepts it. The assets inside are not deleted; they move to the project root.",
    params: { folder: { type: "string", required: true, description: "The folder ID." } },
    inputs: {},
    outputs: [],
    agent: "propose",
    summarize: () => "deleted a folder",
    precondition(request, state) {
      requireFolder(libraryOf(state), parseParams(folderDeleteParams, request.params).folder);
      return Promise.resolve();
    },
    execute: () => Promise.resolve({ outputs: [] }),
  };

  const list: OperationSpec = {
    ...BASE,
    name: ASSET_OPERATIONS.list,
    label: OPERATION_LABELS.list,
    description:
      "List the library's assets, newest first, with their IDs, folder paths, tags and URLs. By default only adopted " +
      "assets are listed; set `review` to `pending` for generated assets that wait for the user's decision, or " +
      "`held`. `folder` is a folder ID or `root`; `q` searches names, tags and the prompts that made the assets; " +
      "`tags` needs all of them. Pass `next_cursor` back as `cursor` for the next page.",
    params: {
      folder: { type: "string", description: "A folder ID, or `root` for assets in no folder." },
      review: {
        type: "string",
        enum: ["pending", "adopted", "held"],
        description: "The review state to list; default `adopted`.",
      },
      kind: {
        type: "string",
        enum: ["image", "video", "audio", "file"],
        description: "Only this kind.",
      },
      q: {
        type: "string",
        description: "Up to 8 words; each must appear in the name, a tag, or the prompt.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Up to 5 tags; all must be present.",
      },
      limit: { type: "integer", description: "Assets per page, 1 to 100; default 30." },
      cursor: { type: "string", description: "The `next_cursor` of the previous page." },
    },
    inputs: {},
    outputs: [],
    readOnly: true,
    summarize: () => "listed assets",
    precondition(request, state) {
      const params = parseParams(listParams, request.params);
      if (params.folder !== undefined && params.folder !== "root") {
        requireFolder(libraryOf(state), brandString<RecordId>(params.folder));
      }
      if (params.cursor !== undefined) decodeCursor(params.cursor);
      if ((params.tags?.length ?? 0) > ASSET_LIMITS.filterTags) {
        throw new ProjectError(
          "invalid_params",
          `Filter by at most ${String(ASSET_LIMITS.filterTags)} tags.`,
        );
      }
      if (
        (params.q ?? "").split(/\s+/).filter((word) => word !== "").length >
        ASSET_LIMITS.searchWords
      ) {
        throw new ProjectError(
          "invalid_params",
          `Search with at most ${String(ASSET_LIMITS.searchWords)} words.`,
        );
      }
      return Promise.resolve();
    },
    execute(context) {
      const params = parseParams(listParams, context.params);
      const query: AssetListQuery = {};
      if (params.folder !== undefined) query.folder = params.folder;
      if (params.review !== undefined) query.review = params.review;
      if (params.kind !== undefined) query.kind = params.kind;
      if (params.q !== undefined) query.q = params.q;
      if (params.tags !== undefined) query.tags = params.tags;
      if (params.limit !== undefined) query.limit = params.limit;
      if (params.cursor !== undefined) query.cursor = params.cursor;
      return Promise.resolve({
        outputs: [],
        report: { ...listAssets(context.state, deps, query) },
      });
    },
  };

  return [importAssets, review, move, tag, remove, folderCreate, folderUpdate, folderDelete, list];
}
