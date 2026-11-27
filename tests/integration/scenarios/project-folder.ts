// Host scenario: where the project layer puts the folder of a new project.

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@cs/project";

export interface ProjectFolderResult {
  folder: string;
}

export const inject = ["csProject"];

export default async function projectFolder(ctx: Context): Promise<ProjectFolderResult> {
  return { folder: await ctx.csProject.newProjectFolder("probe") };
}
