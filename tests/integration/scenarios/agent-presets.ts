// Host scenario: dsh's agent preset roster as the registry reports it (the presets with their
// activation failures, if any) and the default a session made without a named preset gets.
// The registry's types are not a dependency of the tests, so the service is narrowed by hand.

import type { Context } from "@deepseek-ai/cordis";

export interface AgentPresetsResult {
  defaultId: string;
  presets: { id: string; broken?: string }[];
}

interface PresetRegistry {
  readonly defaultId: string;
  list(): Promise<unknown>;
}

export const inject = ["agentPresets"];

function isRegistry(value: unknown): value is PresetRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "defaultId") === "string" &&
    typeof Reflect.get(value, "list") === "function"
  );
}

function presetRows(value: unknown): AgentPresetsResult["presets"] {
  if (!Array.isArray(value)) throw new TypeError("agentPresets.list() returned no array.");
  return value.map((row: unknown) => {
    const id: unknown =
      typeof row === "object" && row !== null ? Reflect.get(row, "id") : undefined;
    const broken: unknown =
      typeof row === "object" && row !== null ? Reflect.get(row, "broken") : undefined;
    if (typeof id !== "string") throw new TypeError("A preset row has no id.");
    return typeof broken === "string" ? { id, broken } : { id };
  });
}

export default async function agentPresets(ctx: Context): Promise<AgentPresetsResult> {
  const registry: unknown = Reflect.get(ctx, "agentPresets");
  if (!isRegistry(registry)) throw new TypeError("ctx.agentPresets is not the preset registry.");
  return { defaultId: registry.defaultId, presets: presetRows(await registry.list()) };
}
