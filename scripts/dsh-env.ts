// Where the development dsh home lives and how the profile is kept pointing at this checkout.
// Background: docs/DSH.md "워크트리와 DSH_HOME".

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const PROFILE = "comfy-studio";
export const BUNDLE_NAME = "@cs/bundle";

/** Root of the checkout this script runs from: the main checkout or a step worktree. */
export const checkoutRoot = resolve(import.meta.dirname, "..");
export const bundleDir = join(checkoutRoot, "packages", "bundle");

const dshEntry = join(checkoutRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

/** The main checkout, which every worktree of this repository shares. */
function mainCheckoutRoot(): string {
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: checkoutRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (basename(commonDir) === ".git") return dirname(commonDir);
  } catch {
    // Not a git checkout (for example an extracted archive).
  }
  return checkoutRoot;
}

/**
 * One home for all worktrees, so model keys and settings survive a step's worktree.
 * `DSH_HOME` overrides it, for running two worktrees at once or for a throwaway home.
 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv) return resolve(fromEnv);
  return join(mainCheckoutRoot(), ".dsh-home");
}

export function dshCommand(args: readonly string[]): { command: string; args: string[] } {
  if (!existsSync(dshEntry)) {
    throw new Error(`dsh is not installed in ${checkoutRoot}. Run "pnpm install" first.`);
  }
  return { command: process.execPath, args: [dshEntry, ...args] };
}

export function dshEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, DSH_HOME: home };
}

/** Runs dsh to completion. Its stdout goes to our stderr so that our own stdout stays clean. */
function runDshQuietly(home: string, args: readonly string[]): void {
  const dsh = dshCommand(args);
  const result = spawnSync(dsh.command, dsh.args, {
    env: dshEnv(home),
    stdio: ["ignore", "ignore", "inherit"],
    // These calls take under a second. The bound is for a stalled pnpm (network, store lock):
    // this is a synchronous call, so without it the caller would hang with no way to time out.
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** True when the profile lists our bundle and links it to this checkout's copy. */
function isBundleLinkedHere(profileDir: string): boolean {
  const manifest: unknown = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
  if (!isRecord(manifest)) return false;

  const dependencies = manifest.dependencies;
  if (!isRecord(dependencies) || dependencies[BUNDLE_NAME] !== `link:${bundleDir}`) return false;

  const dsh = manifest.dsh;
  const profile = isRecord(dsh) ? dsh.profile : undefined;
  const bundles = isRecord(profile) ? profile.bundles : undefined;
  if (!Array.isArray(bundles) || !bundles.includes(BUNDLE_NAME)) return false;

  return samePath(join(profileDir, "node_modules", BUNDLE_NAME), bundleDir);
}

export interface ProfileState {
  home: string;
  profileDir: string;
  created: boolean;
  relinked: boolean;
}

/**
 * Creates the profile if the home has none, then points its bundle link at this checkout.
 * Safe to call before every launch: it changes nothing when the profile is already in place.
 */
export function ensureProfile(home: string): ProfileState {
  const profileDir = join(home, "profiles", PROFILE);

  // --from-default-profile overwrites an existing profile, including values changed in the
  // settings screen, so it only runs when there is no profile yet.
  const created = !existsSync(join(profileDir, "package.json"));
  if (created) {
    runDshQuietly(home, ["--profile", PROFILE, "--from-default-profile", "web", "--dump-config"]);
  }

  // The profile links the bundle by absolute path, and each step works in its own worktree.
  const relinked = !isBundleLinkedHere(profileDir);
  if (relinked) {
    runDshQuietly(home, ["plugin", "--profile", PROFILE, "add", bundleDir]);
    if (!isBundleLinkedHere(profileDir)) {
      throw new Error(`Could not link ${BUNDLE_NAME} into the profile at ${profileDir}.`);
    }
  }

  return { home, profileDir, created, relinked };
}
