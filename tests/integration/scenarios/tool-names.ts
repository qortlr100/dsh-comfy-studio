// Host scenario: lists the registered tools and echoes the input back.

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";

export interface ToolNamesResult {
  names: string[];
  input: unknown;
}

export const inject = ["tools"];

export default function toolNames(ctx: Context, input: unknown): ToolNamesResult {
  return { names: ctx.tools.definitions().map((definition) => definition.name), input };
}
