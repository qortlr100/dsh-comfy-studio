/**
 * Shared fixture of the `@cs/api` unit tests: the real `CsProject` service on a Cordis context (stand-in workspace
 * registry and chats), an in-memory asset store, a throwaway `probe_note` component, the handlers, and a `call` helper
 * that invokes a Fetch route with a real `Request`.
 */
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { onTestFinished } from "vitest";
import CsProject, {
  type AssetId,
  type OperationSpec,
  type ProjectId,
  type ProjectRecord,
  type Reducer,
} from "@cs/project";
import { MemoryAssets, standIn, tempRoot } from "@cs/project/testing/support";
import { provideChatServices, type TestChatServices } from "@cs/project/testing/workspaces";
import { ApiHandlers } from "../api.ts";
import CsApi, { ROUTES } from "../index.ts";

/** The `probe_note` slice: the text of every finished `probe_note.add`, in order. */
export interface NoteSlice {
  notes: string[];
}

/** The reducer of the throwaway component. */
const noteReducer: Reducer<never> & { initial(): NoteSlice } = standIn({
  initial: (): NoteSlice => ({ notes: [] }),
  reduce(slice: NoteSlice, record: ProjectRecord): NoteSlice {
    if (record.operation !== "probe_note.add" || record.status !== "done") return slice;
    return { notes: [...slice.notes, String(record.params["text"])] };
  },
});

/** Does nothing. */
const noop = (): void => undefined;

/** The result of a route call. */
export interface CallResult {
  status: number;
  json: unknown;
}

/** What `call` sends. */
export interface CallOptions {
  query?: Record<string, string>;
  json?: unknown;
  method?: "GET" | "POST";
  /** Send this text as the body instead of JSON. */
  body?: string;
}

/** A mounted API with a project service and the throwaway component. */
export interface ApiFixture {
  context: Context;
  root: string;
  project: CsProject;
  services: TestChatServices;
  assets: MemoryAssets;
  api: ApiHandlers;
  csApi: CsApi;
  routes: ConnectionFetchRoute[];
  /** Hold every `probe_note.slow` run until the returned function is called. */
  holdSlow(): () => void;
  /** Invoke a Fetch route as the browser would, with a real `Request`. */
  call(path: string, options?: CallOptions): Promise<CallResult>;
  /** Create a project through the handlers. */
  newProject(title?: string): Promise<ProjectId>;
}

/**
 * A probe operation with test defaults: no inputs, no outputs, not deterministic, unlimited resource.
 * @param overrides - the fields to set.
 * @returns the spec.
 */
function probe(overrides: Partial<OperationSpec> & Pick<OperationSpec, "name">): OperationSpec {
  return {
    component: "probe_note",
    version: "1",
    description: "A probe operation.",
    params: {},
    inputs: {},
    outputs: [],
    deterministic: false,
    resource: "none",
    summarize: () => "probe",
    execute: () => Promise.resolve({ outputs: [] }),
    ...overrides,
  };
}

/**
 * The operations of the throwaway component.
 * @param gate - the gate `probe_note.slow` waits on.
 * @returns the specs.
 */
function probeOperations(gate: { wait: Promise<void> }): OperationSpec[] {
  const imageOutput: OperationSpec["outputs"] = [{ role: "image", type: "image" }];
  let counter = 0;
  const snap = (context: Parameters<OperationSpec["execute"]>[0]): AssetId => {
    counter += 1;
    return context.importAsset(Buffer.from(`snap ${String(counter)}`), {
      mime: "image/png",
      name: `snap-${String(counter)}.png`,
    });
  };
  return [
    probe({
      name: "probe_note.add",
      description: "Add a note.",
      params: { text: { type: "string", required: true, description: "The note." } },
    }),
    probe({
      name: "probe_note.snap",
      label: "Snap",
      description: "Make an image.",
      outputs: imageOutput,
      execute: (context) => Promise.resolve({ outputs: [snap(context)] }),
    }),
    probe({
      name: "probe_note.slow",
      description: "Make an image once the test lets it.",
      outputs: imageOutput,
      execute: async (context) => {
        await gate.wait;
        return { outputs: [snap(context)] };
      },
    }),
    probe({
      name: "probe_note.use",
      description: "Use an image.",
      inputs: { source: { type: "image", description: "The image.", required: true } },
    }),
    probe({
      name: "probe_note.peek",
      description: "Read the notes.",
      readOnly: true,
      execute: () => Promise.resolve({ outputs: [], report: { read: true } }),
    }),
  ];
}

/**
 * A request to a route URL.
 * @param path - the route path.
 * @param options - the call options.
 * @returns the request.
 */
function requestOf(path: string, options: CallOptions): Request {
  const url = new URL(path, "http://localhost");
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  const method =
    options.method ?? (options.json === undefined && options.body === undefined ? "GET" : "POST");
  const body =
    options.body ?? (options.json === undefined ? undefined : JSON.stringify(options.json));
  return new Request(url, {
    method,
    ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
  });
}

/**
 * Mount `CsProject`, an asset store and the `probe_note` component, and build the handlers. The context is disposed
 * when the current test finishes.
 * @param beforeApi - runs before `CsApi` loads, to provide stand-in services such as `connection` and `webServer`.
 * @returns the fixture.
 */
export async function mountApi(beforeApi: (context: Context) => void = noop): Promise<ApiFixture> {
  const root = tempRoot();
  const context = new Context();
  onTestFinished(async () => {
    await context.fiber.dispose();
  });
  const services = provideChatServices(context);
  await context
    .plugin(CsProject, {
      projectsFolder: join(root, "projects"),
      cpuConcurrency: 1,
      gpuConcurrency: 1,
      promptSectionOrder: 4900,
    })
    .await();
  const project = context.csProject;
  const assets = new MemoryAssets();
  project.registerAssetStore(assets);
  const gate = { wait: Promise.resolve() };
  project.registerComponent("probe_note");
  project.registerReducer(standIn<never>("probe_note"), noteReducer);
  for (const spec of probeOperations(gate)) project.registerOperation(spec);
  beforeApi(context);
  await context.plugin(CsApi, { keepaliveMs: 60_000 }).await();
  const csApi = context.csApi;
  const routes = csApi.fetchRoutes();
  const call = async (path: string, options: CallOptions = {}): Promise<CallResult> => {
    const route = routes.find((candidate) => candidate.path === path);
    if (route === undefined) throw new Error(`No route ${path}`);
    const request = requestOf(path, options);
    if (!route.methods.includes(standIn(request.method))) {
      throw new Error(`Route ${path} does not take ${request.method}`);
    }
    const response = await route.fetch(request);
    const text = await response.text();
    return {
      status: response.status,
      json: text === "" ? null : standIn<unknown>(JSON.parse(text)),
    };
  };
  return {
    context,
    root,
    project,
    services,
    assets,
    api: csApi.api,
    csApi,
    routes,
    holdSlow(): () => void {
      let release = noop;
      gate.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    call,
    async newProject(title = "Probe"): Promise<ProjectId> {
      const info = await csApi.api.createProject({ title });
      return info.id;
    },
  };
}

/** The route paths, for tests that name them. */
export { ROUTES };

/**
 * @param value - a parsed JSON value.
 * @returns the value as a record, for reading fields of a response.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return standIn<Record<string, unknown>>(value);
}
