// Development entry points for running dsh with our bundle.
//
//   node scripts/dsh.ts profile            create the profile if needed and link our bundle
//   node scripts/dsh.ts start [dsh args]   the above, build the browser bundles, launch dsh web
//   node scripts/dsh.ts config [dsh args]  link the bundle, then print the composed profile config

import { spawn } from "node:child_process";
import { buildClientBundles } from "./build-client.ts";
import {
  bundleDir,
  checkoutRoot,
  dshCommand,
  dshEnv,
  ensureProfile,
  PROFILE,
  resolveDshHome,
  type ProfileState,
} from "./dsh-env.ts";

const USAGE = "Usage: node scripts/dsh.ts <profile|start|config> [dsh args]";

// Everything we print goes to stderr. stdout carries only what dsh itself prints.
function report(state: ProfileState): void {
  const profile = state.created ? "created" : "kept";
  const link = !state.relinked ? "unchanged" : state.created ? "linked" : "relinked";
  console.error(`dsh home:  ${state.home}`);
  console.error(`profile:   ${state.profileDir} (${profile})`);
  console.error(`bundle:    ${bundleDir} (${link})`);
}

/** Replaces this process's job with dsh: same stdio, same signals, same exit status. */
function handOverToDsh(home: string, args: readonly string[]): void {
  const dsh = dshCommand(args);
  const child = spawn(dsh.command, dsh.args, { env: dshEnv(home), stdio: "inherit" });

  // Ctrl+C reaches dsh directly through the terminal. We only wait for it to finish.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const home = resolveDshHome();

  switch (command) {
    case "profile":
      report(ensureProfile(home));
      return;
    case "start":
      report(ensureProfile(home));
      // dsh serves lib/client.js as built; without this a stale bundle would go out.
      await buildClientBundles(checkoutRoot);
      handOverToDsh(home, ["--profile", PROFILE, ...rest]);
      return;
    case "config":
      ensureProfile(home);
      handOverToDsh(home, ["--profile", PROFILE, "--dump-config", ...rest]);
      return;
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
