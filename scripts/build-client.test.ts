// Tests for the browser-bundle build. Each test builds fixture workspaces in its own temp dir.
// Background: docs/archive/PLAN_1-1.md "빌드 스크립트 명세".

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildClientBundles } from "./build-client.ts";

const roots: string[] = [];

beforeEach(() => {
  // The build prints one summary line per package; esbuild prints its own errors directly.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cs-build-test-"));
  roots.push(root);
  return root;
}

interface FixtureOptions {
  dir?: string;
  name?: string;
  /** Replaces keys of the default manifest; `undefined` removes the key. */
  manifest?: Record<string, unknown>;
  /** Package-relative path -> contents. Defaults to an empty `src/client/index.ts`. */
  files?: Record<string, string>;
  /** `false` omits tsconfig.client.json. */
  tsconfig?: Record<string, unknown> | false;
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Creates `packages/<dir>` in `root` and returns its absolute path. */
function writePackage(root: string, options: FixtureOptions = {}): string {
  const dir = join(root, "packages", options.dir ?? "demo");
  const name = options.name ?? "@fx/demo";
  const manifest: Record<string, unknown> = {
    name,
    exports: { "./client": "./lib/client.js" },
    dsh: { client: { platform: "web" } },
    ...options.manifest,
  };
  writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  if (options.tsconfig !== false) {
    const compilerOptions = { jsx: "react-jsx", ...options.tsconfig };
    writeFile(join(dir, "tsconfig.client.json"), JSON.stringify({ compilerOptions }));
  }
  const files = options.files ?? { "src/client/index.ts": "export const apply = 1;\n" };
  for (const [path, contents] of Object.entries(files)) writeFile(join(dir, path), contents);
  return dir;
}

interface FakeStyleTag {
  dataset: Record<string, string>;
  textContent: string;
}

interface Loaded {
  id: string;
  exports: Record<string, unknown>;
  tags: FakeStyleTag[];
  requested: string[];
}

/** Runs a built lib/client.js against a fake module loader and a minimal fake document. */
function evaluate(dir: string, tags: FakeStyleTag[] = []): Loaded {
  const code = readFileSync(join(dir, "lib", "client.js"), "utf8");
  const requested: string[] = [];
  let loaded: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined;
  const document = {
    querySelector(selector: string): FakeStyleTag | null {
      const hit = tags.find(
        (tag) => selector === `style[data-plugin-css=${JSON.stringify(tag.dataset.pluginCss)}]`,
      );
      return hit ?? null;
    },
    createElement: (): FakeStyleTag => ({ dataset: {}, textContent: "" }),
    head: {
      appendChild(tag: FakeStyleTag): void {
        tags.push(tag);
      },
    },
  };
  const window = {
    __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) },
  };
  vm.runInNewContext(code, { window, document });
  if (loaded === undefined) throw new Error("the bundle did not call __ModuleLoader__.load");
  const fakeRequire = (id: string): unknown => {
    requested.push(id);
    return { fake: id };
  };
  const exports = loaded.factory(fakeRequire);
  if (!isRecord(exports)) throw new Error("the factory did not return an object");
  return { id: loaded.id, exports, tags, requested };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A CSS Modules export: local name -> generated class names. */
function classMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("not a class map");
  return Object.fromEntries(
    Object.entries(value).map(([key, name]) => {
      if (typeof name !== "string") throw new Error(`class "${key}" is not a string`);
      return [key, name];
    }),
  );
}

/** The build wraps esbuild failures, so the useful text may be on the cause. */
async function buildError(root: string): Promise<string> {
  try {
    await buildClientBundles(root);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const causeText = cause instanceof Error ? cause.message : "";
    const message = error instanceof Error ? error.message : String(error);
    return `${message}\n${causeText}`;
  }
  throw new Error("expected the build to reject");
}

describe("loader format", () => {
  test("wraps the bundle with the loader banner and footer and the factory returns the exports", async () => {
    const root = makeRoot();
    const dir = writePackage(root, {
      files: {
        "src/client/index.ts":
          "export const apply = (): string => 'applied';\nexport const inject = ['a'];\n",
      },
    });
    await buildClientBundles(root);

    const code = readFileSync(join(dir, "lib", "client.js"), "utf8");
    expect(
      code.startsWith(
        'window.__ModuleLoader__.load({ id: "@fx/demo", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
      ),
    ).toBe(true);
    expect(code.trimEnd().endsWith("//# sourceMappingURL=client.js.map")).toBe(true);
    expect(code).toContain("return module.exports; } });");

    const map = readFileSync(join(dir, "lib", "client.js.map"), "utf8");
    expect(map).toContain('"sourcesContent"');
    expect(map).toContain("applied");

    const loaded = evaluate(dir);
    expect(loaded.id).toBe("@fx/demo");
    expect(Object.keys(loaded.exports).toSorted()).toEqual(["apply", "inject"]);
    const apply = loaded.exports.apply;
    if (typeof apply !== "function") throw new Error("apply is not a function");
    expect(apply()).toBe("applied");
    expect(loaded.exports.inject).toEqual(["a"]);
  });
});

describe("shared modules", () => {
  test("stay external and are required from the host", async () => {
    const shared = [
      "react/jsx-runtime",
      "zod",
      "@tanstack/react-virtual",
      "@deepseek-ai/dsh-client-ui-primitives",
    ];
    const imports = shared.map((id, i) => `import * as m${i} from "${id}";`).join("\n");
    const root = makeRoot();
    const dir = writePackage(root, {
      files: {
        "src/client/index.ts": `${imports}\nexport const mods = [${shared.map((_, i) => `m${i}`).join(", ")}];\n`,
      },
    });
    await buildClientBundles(root);

    const code = readFileSync(join(dir, "lib", "client.js"), "utf8");
    for (const id of shared) expect(code).toContain(`require("${id}")`);

    const loaded = evaluate(dir);
    expect(loaded.requested.toSorted()).toEqual(shared.toSorted());
  });
});

describe("rejected imports", () => {
  const cases: { title: string; source: string; message: RegExp }[] = [
    {
      title: "value import from a non-shared @deepseek-ai package",
      source: 'import { x } from "@deepseek-ai/not-shared";\nexport const y = x;\n',
      message: /value import of "@deepseek-ai\/not-shared" is not allowed/,
    },
    {
      title: "react-dom/server",
      source: 'import * as s from "react-dom/server";\nexport const y = s;\n',
      message: /"react-dom\/server" would bundle a second copy of React/,
    },
    {
      title: "plain .css import",
      source: 'import "./plain.css";\nexport const y = 1;\n',
      message: /plain CSS import "\.\/plain\.css" is not allowed/,
    },
  ];

  test.each(cases)("$title", async ({ source, message }) => {
    const root = makeRoot();
    writePackage(root, {
      files: { "src/client/index.ts": source, "src/client/plain.css": ".a { color: red; }\n" },
    });
    const text = await buildError(root);
    expect(text).toContain("@fx/demo: client build failed.");
    expect(text).toMatch(message);
  });

  test("`import { type X }` from a non-shared @deepseek-ai package stays a value import", async () => {
    const root = makeRoot();
    writePackage(root, {
      tsconfig: { verbatimModuleSyntax: true },
      files: {
        "src/client/index.ts":
          'import { type X } from "@deepseek-ai/not-shared";\nexport type Y = X;\n',
      },
    });
    expect(await buildError(root)).toMatch(/value import of "@deepseek-ai\/not-shared"/);
  });

  test("`import type` from a non-shared @deepseek-ai package builds", async () => {
    const root = makeRoot();
    const dir = writePackage(root, {
      tsconfig: { verbatimModuleSyntax: true },
      files: {
        "src/client/index.ts":
          'import type { X } from "@deepseek-ai/not-shared";\nexport const apply = (x: X): X => x;\n',
      },
    });
    await buildClientBundles(root);
    const code = readFileSync(join(dir, "lib", "client.js"), "utf8");
    expect(code).not.toContain("@deepseek-ai/not-shared");
  });
});

describe("CSS Modules", () => {
  const css = [
    ".base { color: red; }",
    ".button { composes: base; background: blue; }",
    ".other { margin: 0; }",
  ].join("\n");
  const entry = [
    'import styles from "./a.module.css";',
    'import again from "./nested/a.module.css";',
    "export const styles1 = styles;",
    "export const styles2 = again;",
    "",
  ].join("\n");

  function cssPackage(root: string): string {
    return writePackage(root, {
      files: {
        "src/client/index.ts": entry,
        "src/client/a.module.css": css,
        "src/client/nested/a.module.css": css,
      },
    });
  }

  test("generates cs-[hash]-[local] names, composes, and injects one tagged style", async () => {
    const root = makeRoot();
    const dir = cssPackage(root);
    await buildClientBundles(root);

    const loaded = evaluate(dir);
    const styles = classMap(loaded.exports.styles1);
    expect(Object.keys(styles)).toEqual(["base", "button", "other"]);
    expect(styles.base).toMatch(/^cs-[A-Za-z0-9_-]+-base$/);
    expect(styles.other).toMatch(/^cs-[A-Za-z0-9_-]+-other$/);
    // composes: own class first, then the composed one
    expect(styles.button).toMatch(/^cs-[A-Za-z0-9_-]+-button cs-[A-Za-z0-9_-]+-base$/);
    expect(styles.button?.endsWith(styles.base ?? "?")).toBe(true);

    // Same file name in a different folder gets its own tag and its own hash.
    expect(
      loaded.tags.map((tag) => tag.dataset.pluginCss ?? "").toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["@fx/demo/a.module.css", "@fx/demo/nested/a.module.css"]);
    for (const tag of loaded.tags) {
      expect(tag.dataset.plugin).toBe("@fx/demo");
      expect(tag.textContent).toContain("background");
    }
    expect(classMap(loaded.exports.styles2).base).not.toBe(styles.base);
  });

  test("injects each style once even if the factory runs twice", async () => {
    const root = makeRoot();
    const dir = cssPackage(root);
    await buildClientBundles(root);

    const tags: FakeStyleTag[] = [];
    evaluate(dir, tags);
    evaluate(dir, tags);
    expect(tags).toHaveLength(2);
  });

  test("class names do not depend on where the workspace lives", async () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    const dirA = cssPackage(rootA);
    const dirB = cssPackage(rootB);
    await buildClientBundles(rootA);
    await buildClientBundles(rootB);

    expect(rootA).not.toBe(rootB);
    expect(evaluate(dirA).exports).toEqual(evaluate(dirB).exports);
  });
});

describe("manifest validation", () => {
  const cases: { title: string; options: FixtureOptions; message: RegExp }[] = [
    {
      title: "dsh.client.platform is not web",
      options: { manifest: { dsh: { client: { platform: "node" } } } },
      message: /dsh\.client\.platform must be "web"/,
    },
    {
      title: 'exports["./client"] is wrong',
      options: { manifest: { exports: { "./client": "./dist/client.js" } } },
      message: /exports\["\.\/client"\] must be "\.\/lib\/client\.js"/,
    },
    {
      title: 'exports["./client"] is missing',
      options: { manifest: { exports: { ".": "./src/index.ts" } } },
      message: /exports\["\.\/client"\] must be/,
    },
    {
      title: "there is no entry file",
      options: { files: { "src/client/other.ts": "export {};\n" } },
      message: /no entry point/,
    },
    {
      title: "both index.ts and index.tsx exist",
      options: { files: { "src/client/index.ts": "export {};\n", "src/client/index.tsx": "" } },
      message: /both src\/client\/index\.ts and src\/client\/index\.tsx exist/,
    },
    {
      title: "tsconfig.client.json is missing",
      options: { tsconfig: false },
      message: /tsconfig\.client\.json is missing/,
    },
    {
      title: "dsh.client.external is present",
      options: { manifest: { dsh: { client: { platform: "web", external: ["x"] } } } },
      message: /dsh\.client\.external is not supported/,
    },
  ];

  test.each(cases)("rejects when $title", async ({ options, message }) => {
    const root = makeRoot();
    writePackage(root, options);
    await expect(buildClientBundles(root)).rejects.toThrow(/^@fx\/demo: /);
    await expect(buildClientBundles(root)).rejects.toThrow(message);
  });
});

describe("nothing to build", () => {
  test("a root without packages/ resolves and writes nothing", async () => {
    const root = makeRoot();
    await buildClientBundles(root);
    expect(readdirSync(root)).toEqual([]);
  });

  test("packages without dsh.client are skipped and nothing is written", async () => {
    const root = makeRoot();
    const dir = writePackage(root, { manifest: { dsh: undefined } });
    await buildClientBundles(root);
    expect(existsSync(join(dir, "lib"))).toBe(false);
    expect(readdirSync(join(root, "packages"))).toEqual(["demo"]);
  });
});
