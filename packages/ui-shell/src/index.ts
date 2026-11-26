// Host half. Empty until the shell has host-side work. Node runs this file as is (type
// stripping), so it uses erasable syntax only and relative imports carry the .ts extension.

import type { Context } from "@deepseek-ai/cordis";

export const name = "cs-ui-shell";

export function apply(_ctx: Context): void {}
