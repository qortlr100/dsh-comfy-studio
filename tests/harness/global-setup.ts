// Runs once before the integration tests: dsh refuses to start while a package's browser
// bundle (lib/client.js) is missing, and a stale one would test old code.

import { buildClientBundles } from "../../scripts/build-client.ts";
import { checkoutRoot } from "../../scripts/dsh-env.ts";

export default async function setup(): Promise<void> {
  await buildClientBundles(checkoutRoot);
}
