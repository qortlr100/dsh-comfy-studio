/**
 * The asset service on a Cordis context with the real project layer: the store is registered as the project layer's
 * asset store, bytes staged through `csAsset` enter the library through `asset.import`, and the routes are registered
 * while a Connection is mounted.
 */
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { describe, expect, it, onTestFinished } from "vitest";
import CsProject, { type ProjectId } from "@cs/project";
import { standIn, tempRoot, userOrigin } from "@cs/project/testing/support";
import { chatProject, provideChatServices } from "@cs/project/testing/workspaces";
import CsAsset, { ASSET_ROUTES } from "./index.ts";

/** Mount the project layer and the asset service, and make a project. */
async function mount(
  config: { publicBaseUrl: string; maxUploadBytes: number } = {
    publicBaseUrl: "",
    maxUploadBytes: 1000,
  },
  before: (context: Context) => void = () => undefined,
) {
  const root = tempRoot();
  const context = new Context();
  onTestFinished(async () => {
    await context.fiber.dispose();
  });
  const services = provideChatServices(context);
  before(context);
  await context
    .plugin(CsProject, {
      projectsFolder: join(root, "projects"),
      cpuConcurrency: 1,
      gpuConcurrency: 1,
      promptSectionOrder: 4900,
    })
    .await();
  await context.plugin(CsAsset, config).await();
  const project = await chatProject(context.csProject, services, "Assets", userOrigin());
  return { context, project, csAsset: context.csAsset, csProject: context.csProject };
}

/** @returns the bytes of a tiny PNG-like file. */
const bytes = (): Uint8Array => new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

/** Run `asset.import` on an asset as the user. */
function importAsset(
  csProject: CsProject,
  project: ProjectId,
  asset: ReturnType<CsAsset["stage"]>,
) {
  return csProject.run({
    ...userOrigin({ session: null }),
    project,
    operation: "asset.import",
    params: {},
    inputs: [{ role: "file", ref: { asset } }],
  });
}

describe("CsAsset", () => {
  it("registers the asset store so staged bytes are known to the project layer", async () => {
    const { csAsset, csProject, project } = await mount({
      publicBaseUrl: "https://studio.example/",
      maxUploadBytes: 1000,
    });
    const id = csAsset.stage(project, bytes(), { mime: "image/png", name: "staged.png" });
    const reader = csProject.assets();
    expect(reader.has(id)).toBe(true);
    expect(reader.get(id)).toMatchObject({ mime: "image/png", name: "staged.png", size_bytes: 7 });
    expect(reader.url(id)).toBe(`https://studio.example/api/cs/asset?id=${id}`);
    expect(Buffer.from(reader.read(id))).toEqual(Buffer.from(bytes()));
    expect(csAsset.find(id)?.name).toBe("staged.png");
    expect(csAsset.path(id)).toContain(id);
    // Staged bytes are not in the library until a record imports them.
    expect(csProject.getState(project).components.asset?.items[id]).toBeUndefined();
  });

  it("brings an asset into the library with asset.import and keeps it readable", async () => {
    const { csAsset, csProject, project } = await mount();
    expect(csProject.listOperations().map((spec) => spec.name)).toContain("asset.import");
    const id = csAsset.stage(project, bytes(), { mime: "image/png", name: "staged.png" });
    const result = await importAsset(csProject, project, id);
    expect(result.outputs).toEqual([id]);
    expect(csProject.getState(project).components.asset?.items[id]).toMatchObject({
      origin: "import",
      review: "adopted",
    });
    expect(csProject.assets().get(id).name).toBe("staged.png");
  });

  it("answers null for the thumbnail of an asset while ffmpeg is not mounted", async () => {
    const { csAsset, project } = await mount();
    const id = csAsset.stage(project, bytes(), { mime: "image/png", name: "a.png" });
    expect(await csAsset.thumbOf(id)).toBeNull();
  });

  it("registers the routes while a Connection is mounted", async () => {
    const registered: string[] = [];
    await mount(undefined, (context) => {
      context.provide(
        "connection",
        standIn({
          fetch: {
            register: (route: ConnectionFetchRoute) => {
              registered.push(route.path);
              return () => Promise.resolve();
            },
          },
        }),
      );
    });
    expect(registered.toSorted()).toEqual(Object.values(ASSET_ROUTES).toSorted());
  });

  it("registers no route without a Connection", async () => {
    const { context } = await mount();
    expect(context.get("connection")).toBeUndefined();
  });
});
