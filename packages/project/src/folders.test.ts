/**
 * The projects folder of `csProject`: the configured folder, else `comfy-studio-projects` in the home directory, a
 * load failure that names `CS_PROJECTS_FOLDER` when the home directory does not resolve, and fresh, distinct folders
 * for new projects.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import CsProject, { DEFAULT_PROJECTS_FOLDER } from "./index.ts";
import { tempRoot } from "./testing/support.ts";
import { provideChatServices } from "./testing/workspaces.ts";

const home = vi.hoisted((): { folder: string | null } => ({ folder: "" }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  // `null` stands for an account without a home directory, for which Node's `homedir` throws.
  homedir: () => {
    if (home.folder === null) throw new Error("ENOENT: no such file or directory, uv_os_homedir");
    return home.folder;
  },
}));

const contexts: Context[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

/**
 * Load `csProject`.
 * @param config - the config besides the defaults.
 * @returns the plugin's fiber and the context.
 */
function load(config: { projectsFolder?: string }) {
  const context = new Context();
  contexts.push(context);
  provideChatServices(context);
  const fiber = context.plugin(CsProject, {
    cpuConcurrency: 1,
    gpuConcurrency: 1,
    promptSectionOrder: 4900,
    ...config,
  });
  return { context, fiber };
}

describe("the projects folder", () => {
  it("makes fresh folders with distinct names in the configured folder", async () => {
    const root = tempRoot();
    const { context, fiber } = load({ projectsFolder: join(root, "projects") });
    await fiber.await();
    const folders = await Promise.all([
      context.csProject.newProjectFolder("a/b"),
      context.csProject.newProjectFolder("a/b"),
    ]);
    expect(folders.toSorted()).toEqual([
      join(root, "projects", "a-b"),
      join(root, "projects", "a-b 2"),
    ]);
    expect(readdirSync(join(root, "projects")).toSorted()).toEqual(["a-b", "a-b 2"]);
    await expect(context.csProject.newProjectFolder(" ")).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("defaults to comfy-studio-projects in the home directory, and fails to load naming CS_PROJECTS_FOLDER without a home directory or for a relative folder", async () => {
    const root = tempRoot();
    home.folder = join(root, "home");
    const found = load({});
    await found.fiber.await();
    expect(DEFAULT_PROJECTS_FOLDER).toBe("comfy-studio-projects");
    expect(await found.context.csProject.newProjectFolder("Untitled project")).toBe(
      join(root, "home", "comfy-studio-projects", "Untitled project"),
    );
    home.folder = "";
    const missing = load({});
    await expect(missing.fiber.await()).rejects.toThrow(/Set CS_PROJECTS_FOLDER/);
    home.folder = null;
    await expect(load({}).fiber.await()).rejects.toThrow(/Set CS_PROJECTS_FOLDER/);
    await expect(load({ projectsFolder: "" }).fiber.await()).rejects.toThrow(
      /must be an absolute path/,
    );
    await expect(load({ projectsFolder: "relative/projects" }).fiber.await()).rejects.toThrow(
      /must be an absolute path/,
    );
  });
});
