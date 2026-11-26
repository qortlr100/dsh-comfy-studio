// Builds the browser half of each plugin package into lib/client.js, in the format the dsh
// browser module loader accepts. Background: docs/archive/PLAN_1-1.md "빌드 스크립트 명세",
// docs/DSH.md "브라우저 번들".
//
//   node scripts/build-client.ts
//
// Based on upstream packages/client/tsdown.client.ts (tag dsh-v0.2.2-rc.5), redone on esbuild
// because the upstream preset is not published to npm.

import { build, type Metafile, type Plugin } from "esbuild";
import { transform } from "lightningcss";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkoutRoot } from "./dsh-env.ts";

/**
 * Modules the dsh browser loader hands to every plugin at run time, so they must not be bundled.
 * Mirrors PLATFORM_MODULES in upstream packages/client/web/src/platform.ts. Matched by exact
 * specifier: "react-dom/client" is shared, "react-dom/server" is not.
 */
const SHARED_MODULES: ReadonlySet<string> = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "zod",
  "@tanstack/react-virtual",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
]);

/** React must never be bundled: a second copy breaks hooks, so the families are rejected. */
const REACT_FAMILY = /^(?:react|react-dom|scheduler)(?:\/|$)/;
const REACT_INPUT_DIRS = [
  "node_modules/react/",
  "node_modules/react-dom/",
  "node_modules/scheduler/",
];

const CSS_MODULE_NAMESPACE = "cs-css-module";
// Not "[hash]_[local]" like upstream: dsh hides some of its own elements with suffix selectors
// such as [class$="_newSession"], which would also match our classes. See docs/DSH.md.
const CSS_CLASS_PATTERN = "cs-[hash]-[local]";

interface ClientTarget {
  name: string;
  dir: string;
  entry: string;
}

interface PackageManifest {
  name?: unknown;
  exports?: unknown;
  dsh?: { client?: { platform?: unknown; external?: unknown } };
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** `exports["./client"]` may be a string or a conditions object whose `default` is the file. */
function clientExportPath(manifest: PackageManifest): unknown {
  const exports = manifest.exports;
  if (typeof exports !== "object" || exports === null) return undefined;
  const entry: unknown = (exports as Record<string, unknown>)["./client"];
  if (typeof entry === "object" && entry !== null) {
    return (entry as Record<string, unknown>).default;
  }
  return entry;
}

/** Finds every package with `dsh.client` and checks that its manifest and files can be built. */
function discoverTargets(root: string): ClientTarget[] {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];

  const targets: ClientTarget[] = [];
  for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = join(packagesDir, dirent.name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
    const client = manifest.dsh?.client;
    if (client === undefined) continue;

    const name = typeof manifest.name === "string" ? manifest.name : dirent.name;
    if (client.platform !== "web") {
      throw new Error(`${name}: dsh.client.platform must be "web" in ${manifestPath}.`);
    }
    if (clientExportPath(manifest) !== "./lib/client.js") {
      throw new Error(
        `${name}: exports["./client"] must be "./lib/client.js" in ${manifestPath}, which is ` +
          "where this script writes the bundle.",
      );
    }
    if (client.external !== undefined) {
      throw new Error(
        `${name}: dsh.client.external is not supported by this build. Remove it from ` +
          `${manifestPath}, or extend scripts/build-client.ts first.`,
      );
    }

    const candidates = ["index.ts", "index.tsx"]
      .map((file) => join(dir, "src", "client", file))
      .filter((file) => existsSync(file));
    if (candidates.length === 0) {
      throw new Error(
        `${name}: no entry point. Create src/client/index.ts or src/client/index.tsx.`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `${name}: both src/client/index.ts and src/client/index.tsx exist. Keep only one.`,
      );
    }
    if (!existsSync(join(dir, "tsconfig.client.json"))) {
      throw new Error(`${name}: tsconfig.client.json is missing in ${dir}.`);
    }
    targets.push({ name, dir, entry: candidates[0] as string });
  }
  return targets.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The module a `*.module.css` import turns into: inject the CSS once, export the class map. */
function styleInjectionModule(
  packageName: string,
  tagId: string,
  css: string,
  classes: Record<string, string>,
): string {
  const sorted = Object.fromEntries(
    Object.entries(classes).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {`,
    `  const tag = document.createElement("style");`,
    // The loader finds style tags by this attribute and removes them when the plugin goes down.
    `  tag.dataset.plugin = ${JSON.stringify(packageName)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
    `export default ${JSON.stringify(sorted)};`,
    ``,
  ].join("\n");
}

/** Applies the shared-module externals and the import rejections, and handles CSS Modules. */
function clientPlugin(target: ClientTarget): Plugin {
  const clientDir = join(target.dir, "src", "client");
  return {
    name: "cs-client",
    setup(pluginBuild) {
      // Runs for imports inside node_modules too, so a third-party package cannot pull in a
      // second React or a host-only dsh package. Type-only imports never get here.
      pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.csSkip === true) return undefined;
        const path = args.path;

        if (SHARED_MODULES.has(path)) return { path, external: true };

        if (path.startsWith("@deepseek-ai/")) {
          return {
            errors: [
              {
                text:
                  `${target.name}: value import of "${path}" is not allowed in the browser half. ` +
                  "Use `import type` if you only need types, and receive behaviour through the " +
                  "services injected by the plugin.",
              },
            ],
          };
        }
        if (REACT_FAMILY.test(path)) {
          return {
            errors: [
              {
                text:
                  `${target.name}: import of "${path}" would bundle a second copy of React. ` +
                  "Only react, react/jsx-runtime, react-dom and react-dom/client are shared " +
                  "with dsh. Use one of those, or drop the dependency.",
              },
            ],
          };
        }

        const bare = path.replace(/[?#].*$/, "");
        if (bare.endsWith(".css")) {
          if (!bare.endsWith(".module.css")) {
            return {
              errors: [
                {
                  text:
                    `${target.name}: plain CSS import "${path}" is not allowed. ` +
                    "Rename the file to *.module.css.",
                },
              ],
            };
          }
          const resolved = await pluginBuild.resolve(path, {
            kind: args.kind,
            resolveDir: args.resolveDir,
            importer: args.importer,
            pluginData: { csSkip: true },
          });
          if (resolved.errors.length > 0) return { errors: resolved.errors };
          return { path: resolved.path, namespace: CSS_MODULE_NAMESPACE };
        }
        return undefined;
      });

      pluginBuild.onLoad({ filter: /.*/, namespace: CSS_MODULE_NAMESPACE }, (args) => {
        try {
          const source = readFileSync(args.path);
          const rel = toPosix(relative(target.dir, args.path));
          const result = transform({
            // Package-relative, so hashes do not depend on where the checkout lives and do not
            // collide between packages.
            filename: `${target.name}/${rel}`,
            code: source,
            cssModules: { pattern: CSS_CLASS_PATTERN },
            minify: true,
          });
          const classes: Record<string, string> = {};
          for (const [local, info] of Object.entries(result.exports ?? {})) {
            classes[local] = [info.name, ...info.composes.map((c) => c.name)].join(" ");
          }
          // Relative to src/client so the same file name in different folders stays distinct.
          let tagPath = toPosix(relative(clientDir, args.path));
          if (tagPath.startsWith("..")) tagPath = rel;
          const contents = styleInjectionModule(
            target.name,
            `${target.name}/${tagPath}`,
            result.code.toString(),
            classes,
          );
          return { contents, loader: "js", watchFiles: [args.path] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            errors: [{ text: `${target.name}: cannot process ${args.path}: ${message}` }],
          };
        }
      });
    },
  };
}

/** Names of the third-party packages whose files ended up in the bundle. */
function bundledPackages(metafile: Metafile): string[] {
  const names = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const matches = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
    // The last match is the real package under pnpm's node_modules/.pnpm/<id>/node_modules/.
    const last = matches.at(-1);
    if (last?.[1] !== undefined) names.add(last[1]);
  }
  return [...names].toSorted();
}

async function buildTarget(target: ClientTarget): Promise<void> {
  const outfile = join(target.dir, "lib", "client.js");
  let result;
  try {
    result = await build({
      entryPoints: [target.entry],
      bundle: true,
      format: "cjs",
      platform: "browser",
      target: "es2024",
      jsx: "automatic",
      tsconfig: join(target.dir, "tsconfig.client.json"),
      outfile,
      sourcemap: "linked",
      sourcesContent: true,
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "warning",
      metafile: true,
      plugins: [clientPlugin(target)],
      // Wrapping with banner and footer keeps the source map aligned, unlike string splicing.
      banner: {
        js:
          `window.__ModuleLoader__.load({ id: ${JSON.stringify(target.name)}, ` +
          "factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
      },
      footer: { js: "return module.exports; } });" },
    });
  } catch (error) {
    // esbuild already printed each error with its location, so the message is not repeated.
    throw new Error(`${target.name}: client build failed.`, { cause: error });
  }

  // Last line of defence in case the rejection rules above are bypassed.
  const reactInputs = Object.keys(result.metafile.inputs).filter((input) =>
    REACT_INPUT_DIRS.some((dir) => input.includes(dir)),
  );
  if (reactInputs.length > 0) {
    throw new Error(
      `${target.name}: React was bundled into lib/client.js (${reactInputs[0]}). ` +
        "React must come from dsh; find the import that pulls it in.",
    );
  }

  const bytes = statSync(outfile).size;
  const packages = bundledPackages(result.metafile);
  console.error(`${target.name}: ${bytes} bytes, bundled: ${packages.join(", ") || "none"}`);
}

/** Builds lib/client.js for every package under `root/packages` that declares `dsh.client`. */
export async function buildClientBundles(root: string): Promise<void> {
  for (const target of discoverTargets(root)) {
    await buildTarget(target);
  }
}

if (import.meta.main) {
  try {
    await buildClientBundles(checkoutRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
