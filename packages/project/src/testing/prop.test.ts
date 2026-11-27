/**
 * The `prop` fixture: a test-only plugin that adds the reference kind `prop` through the kernel API alone, with its own
 * component key, reducer and two operations. Through the real `csProject` service and DSH tool registry, an input
 * `p1@1` resolves to the prop's assets, an update makes what read the version stale, the `inputs` text of the operation
 * tools lists the kind, and removing the plugin removes the kind. The fixture declares no `ComponentStates` or
 * `ReferenceKinds` entry, so it never clashes with a real `prop` package.
 */
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { afterEach, describe, expect, it } from "vitest";
import CsProject, {
  type AssetId,
  type OperationSpec,
  type OperationToolValue,
  type ProjectRecord,
  type RecordId,
  type Reducer,
  type ReferenceKindSpec,
  type RunRequest,
} from "../index.ts";
import { MemoryAssets, tempRoot } from "./support.ts";
import { chatProject, provideChatServices, callTool, mountTools } from "./workspaces.ts";

/** The `prop` slice: each prop's versions, oldest first, with the assets and the record of each. */
type PropSlice = Record<string, Array<{ assets: AssetId[]; record: RecordId }>>;

/** The `prop` reducer: a finished `prop.create` or `prop.update` adds the next version of `params.prop`. */
const propReducer: Reducer<never> & { initial(): PropSlice } = {
  initial: () => ({}),
  reduce(slice: PropSlice, record: ProjectRecord): PropSlice {
    if (
      !["prop.create", "prop.update"].includes(record.operation ?? "") ||
      record.status !== "done"
    )
      return slice;
    const id = String(record.params["prop"]);
    const assets = record.inputs.flatMap((input) =>
      input.resolved_asset === null ? [] : [input.resolved_asset],
    );
    return { ...slice, [id]: [...(slice[id] ?? []), { assets, record: record.id }] };
  },
} as never;

/** The reference kind `prop`, which answers from the `prop` slice. */
const propKind: ReferenceKindSpec<never> = {
  kind: "prop",
  component: "prop" as never,
  assetsOf: (slice: PropSlice, id, version) => slice[id]?.[version - 1]?.assets ?? null,
  createdBy: (slice: PropSlice, id, version) => slice[id]?.[version - 1]?.record ?? null,
  latest: (slice: PropSlice, id) => slice[id]?.length ?? null,
};

/** `prop.create` or `prop.update`; an update replaces the record of the prop's previous version. */
function propOperation(verb: "create" | "update"): OperationSpec {
  return {
    name: `prop.${verb}`,
    component: "prop",
    version: "1",
    description: `Prop ${verb}.`,
    params: { prop: { type: "string", required: true, description: "The prop ID." } },
    inputs: { reference: { type: "image", many: true, description: "Images of the prop." } },
    outputs: [],
    deterministic: false,
    resource: "none",
    summarize: () => `prop ${verb}`,
    supersedes: (params, state) =>
      verb === "create"
        ? []
        : state.components.proj.records
            .filter(
              (record) => record.component === "prop" && record.params["prop"] === params["prop"],
            )
            .slice(-1)
            .map((record) => record.id),
    execute: () => Promise.resolve({ outputs: [] }),
  };
}

/**
 * Register the fixture the way a plugin does: component key, reducer, reference kind, operations.
 * @param project - the service.
 * @returns the disposer of every registration.
 */
function registerProp(project: CsProject): () => void {
  const disposers = [
    project.registerComponent("prop"),
    project.registerReducer("prop" as never, propReducer),
    project.registerReferenceKind(propKind),
    project.registerOperation(propOperation("create")),
    project.registerOperation(propOperation("update")),
  ];
  return () => {
    for (const dispose of disposers.toReversed()) dispose();
  };
}

const contexts: Context[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

describe("the prop fixture", () => {
  it("adds the reference kind prop without a kernel edit", async () => {
    const root = tempRoot();
    const context = new Context();
    contexts.push(context);
    const services = provideChatServices(context);
    await context.plugin(SystemPrompt, {}).await();
    await mountTools(context);
    await context
      .plugin(CsProject, {
        projectsFolder: join(root, "projects"),
        cpuConcurrency: 1,
        gpuConcurrency: 1,
        promptSectionOrder: 4900,
      })
      .await();
    const cs = context.csProject;
    const assets = new MemoryAssets();
    cs.registerAssetStore(assets);
    cs.registerComponent("look");
    cs.registerOperation({
      name: "look.make",
      component: "look",
      version: "1",
      description: "Make a look.",
      params: {},
      inputs: {
        reference: { type: "image", many: true, versioned: true, description: "References." },
      },
      outputs: [],
      deterministic: false,
      resource: "none",
      summarize: () => "look",
      execute: () => Promise.resolve({ outputs: [] }),
    });
    const removeProp = registerProp(cs);
    const user = {
      actor: "user",
      surface: "api",
      session: null,
      turn: null,
      tool_call: null,
      intent: "edit",
    } as const;
    const project = await chatProject(cs, services, "props", user);
    const run = async (
      operation: string,
      params: Record<string, unknown>,
      inputs: RunRequest["inputs"],
    ) => (await cs.run({ ...user, project, operation, params, inputs })).record?.id;
    const lamp = assets.importAsset(project, Buffer.from("lamp"), {
      mime: "image/png",
      name: "lamp.png",
    });
    await run("prop.create", { prop: "p1" }, [{ role: "reference", ref: { asset: lamp } }]);
    const inputsText = () =>
      JSON.stringify(
        context.tools.schemas().find((tool) => tool.name === "cs_look_make")?.parameters,
      );
    expect(cs.listReferenceKinds()).toEqual(["prop"]);
    expect(inputsText()).toContain("or <id>@<version> (a prop version; cs_proj_state lists IDs)");
    // The agent names the version as p1@1; the record reads the prop's assets.
    const result = await callTool(
      context,
      "call-1",
      "cs_look_make",
      { reason: "use the lamp", inputs: { reference: ["p1@1"] } },
      { id: "s1" },
    );
    const made = (result.isError ? undefined : (result.value as OperationToolValue))?.record;
    const ref = cs.parseReference("p1@1", cs.getState(project));
    expect(ref).toEqual({ prop: "p1", version: 1 });
    expect(
      cs.getState(project).components.proj.records.find((record) => record.id === made)?.inputs,
    ).toEqual([{ role: "reference", ref, resolved_asset: lamp }]);
    const update = await run("prop.update", { prop: "p1" }, []);
    expect(cs.getState(project).components.proj.stale).toEqual({ [String(made)]: update });
    removeProp();
    expect(inputsText()).not.toContain("<id>@<version> (");
    expect(() => cs.parseReference("p1@1", cs.getState(project))).toThrow(
      expect.objectContaining({ code: "invalid_inputs" }),
    );
  });
});
