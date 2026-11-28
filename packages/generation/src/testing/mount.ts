/**
 * A mounted stack for the tests of the generation component: the real project layer, catalog, workflow component and
 * generation component on one Cordis context, over an in-memory asset store that keeps the bytes it is given (files
 * too), with one project. A test registers fake `graph` entries and makes workflows through the real operations.
 *
 * @module @cs/generation/testing/mount
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { onTestFinished } from "vitest";
import CsCatalog from "@cs/catalog";
import type { FakeGraphEntry } from "@cs/catalog/testing/fake-provider";
import { MAX_SEED, type ApiGraph, type WorkflowParam } from "@cs/comfy/workflow";
import CsProject from "@cs/project";
import type {
  AssetId,
  ProjectId,
  ProjectRecord,
  RecordId,
  RecordInputRef,
  RunResult,
} from "@cs/project/types";
import {
  MemoryAssets,
  agentOrigin,
  defined,
  tempRoot,
  userOrigin,
} from "@cs/project/testing/support";
import { chatProject, provideChatServices } from "@cs/project/testing/workspaces";
import CsWorkflow from "@cs/workflow";
import CsGeneration from "../index.ts";
import { GEN_OPERATIONS } from "../types.ts";

/** An asset store that stores the bytes of a file when the source is a path (`MemoryAssets` stores the path text). */
export class FileAssets extends MemoryAssets {
  override importAsset(
    project: ProjectId,
    source: Uint8Array | { path: string },
    meta: { mime: string; name: string },
  ): AssetId {
    const bytes = source instanceof Uint8Array ? source : readFileSync(source.path);
    return super.importAsset(project, Uint8Array.from(bytes), meta);
  }
}

/** A small text-to-image graph with a `LoadImage` node `10` that nothing reads. */
export function graphWithImage(): ApiGraph {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: 156680208700286,
        steps: 20,
        cfg: 8,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "v1-5.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
    "10": { class_type: "LoadImage", inputs: { image: "example.png" } },
  };
}

/** The fields the tests expose: a prompt, a seed, the steps, and the image of node 10. */
export function sampleFields(): WorkflowParam[] {
  return [
    {
      id: "6.text",
      nodeId: "6",
      input: "text",
      label: "Prompt",
      type: "text",
      default: "a cat",
      multiline: true,
    },
    {
      id: "3.seed",
      nodeId: "3",
      input: "seed",
      label: "Seed",
      type: "seed",
      default: 156680208700286,
      min: 0,
      max: MAX_SEED,
    },
    {
      id: "3.steps",
      nodeId: "3",
      input: "steps",
      label: "Steps",
      type: "integer",
      default: 20,
      min: 1,
      max: 100,
    },
    {
      id: "10.image",
      nodeId: "10",
      input: "image",
      label: "Reference image",
      type: "image",
      default: "example.png",
    },
  ];
}

/** What a test says about one `gen.run` call beyond its params. */
export interface RunOptions {
  /** The `media` inputs: assets, or `{record, output}` references. */
  media?: RecordInputRef[];
  /** Call as the agent of a chat turn instead of as the user. */
  agent?: boolean;
  signal?: AbortSignal;
}

/**
 * Mount the stack with one project.
 * @returns the handle the tests drive.
 */
export async function mount() {
  const root = tempRoot();
  const context = new Context();
  onTestFinished(async () => {
    await context.fiber.dispose();
  });
  const services = provideChatServices(context);
  await context
    .plugin(CsProject, {
      projectsFolder: join(root, "projects"),
      cpuConcurrency: 1,
      gpuConcurrency: 1,
      promptSectionOrder: 4900,
    })
    .await();
  const assets = new FileAssets();
  context.csProject.registerAssetStore(assets);
  await context.plugin(CsCatalog, { factsTimeoutMs: 1000 }).await();
  await context.plugin(CsWorkflow, {}).await();
  await context.plugin(CsGeneration, {}).await();
  const { csProject, csCatalog } = context;
  const project = await chatProject(csProject, services, "Generation", userOrigin());

  const f = {
    context,
    csProject,
    csCatalog,
    assets,
    project,
    /** Register a fake entry; returns the function that removes it. */
    register(entry: FakeGraphEntry): () => void {
      return csCatalog.register(entry);
    },
    /** The names of the registered operations. */
    operationNames(): string[] {
      return csProject.listOperations().map((spec) => spec.name);
    },
    /** Put bytes into the asset store and get the asset ID. */
    upload(text: string, name = "ref.png", mime = "image/png"): AssetId {
      return assets.importAsset(project, Buffer.from(text), { mime, name });
    },
    /** Make a workflow as the user, exposing `fields`; returns its ID. */
    async makeWorkflow(
      options: {
        graph?: ApiGraph;
        fields?: WorkflowParam[];
        target?: { provider: string; target: string };
        name?: string;
      } = {},
    ): Promise<RecordId> {
      const file = assets.importAsset(
        project,
        Buffer.from(JSON.stringify(options.graph ?? graphWithImage())),
        { mime: "application/json", name: "flow.json" },
      );
      const made = await csProject.run({
        ...userOrigin(),
        project,
        operation: "workflow.create",
        params: {
          name: options.name ?? "Flow",
          ...(options.target === undefined ? {} : { target: options.target }),
        },
        inputs: [{ role: "file", ref: { asset: file } }],
      });
      const id = defined(made.record, "the workflow record").id;
      await csProject.run({
        ...userOrigin(),
        project,
        operation: "workflow.update",
        params: { workflow: id, fields: options.fields ?? sampleFields() },
        inputs: [],
      });
      return id;
    },
    /** Call `gen.run`; resolves with the record as `run` wrote it (`pending` once it is queued). */
    run(params: Record<string, unknown>, options: RunOptions = {}): Promise<RunResult> {
      return csProject.run({
        ...(options.agent === true ? agentOrigin() : userOrigin()),
        project,
        operation: GEN_OPERATIONS.run,
        params,
        inputs: (options.media ?? []).map((ref) => ({ role: "media", ref })),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    },
    /** Call `gen.run` and wait until the record has ended; resolves with it in its final form. */
    async runToEnd(
      params: Record<string, unknown>,
      options: RunOptions = {},
    ): Promise<ProjectRecord> {
      const queued = defined((await f.run(params, options)).record, "the gen.run record");
      await csProject.wait(project, [queued.id]);
      return csProject.getRecord(project, queued.id);
    },
    /** Call another operation of the component as the user (or the agent). */
    call(
      operation: string,
      params: Record<string, unknown> = {},
      agent = false,
    ): Promise<RunResult> {
      return csProject.run({
        ...(agent ? agentOrigin() : userOrigin()),
        project,
        operation,
        params,
        inputs: [],
      });
    },
    /** The project's current state. */
    state() {
      return csProject.getState(project);
    },
  };
  return f;
}

/** The handle `mount` returns. */
export type Mounted = Awaited<ReturnType<typeof mount>>;
