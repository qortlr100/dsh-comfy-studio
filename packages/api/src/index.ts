/**
 * The view API. While a Connection service is mounted, the plugin registers authenticated Fetch routes under
 * `/api/cs/*`; while a web server is mounted beside it, it serves a project's changes as server-sent events at
 * `/cs/events`, admitting a request only when Connection admits it as the owner. Browser views read the project state
 * through these routes and write records through `csProject.run`, the same entry point the agent's tools use. While a
 * generation catalog (`csCatalog`) is mounted, `/api/cs/catalog` lists its entries and every stream says when it
 * changed; without one the list is empty.
 *
 * @module @cs/api
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-host-webserver";
import z from "@deepseek-ai/schemastery";
import type CsCatalog from "@cs/catalog";
import type {} from "@cs/project";
import type { ProjectId } from "@cs/project";
import { answer, ApiHandlers, ApiRequestError, requireProject } from "./api.ts";
import { serveEventStream } from "./events.ts";

export {
  answer,
  ApiHandlers,
  ApiRequestError,
  messageOf,
  type OperationRequest,
  type RequestSurface,
} from "./api.ts";
export { CATALOG_FRAME, frameOf, serveEventStream, type EventStreamSources } from "./events.ts";
export type { WireProjectCover, WireProjectSummary } from "./summaries.ts";
export {
  mentionedAssets,
  projectIdOf,
  toWireOperation,
  toWireState,
  type ProjectAsset,
  type WireAsset,
  type WireCatalogEntry,
  type WireHistory,
  type WireOperation,
  type WireProject,
  type WireState,
} from "./wire.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The view API: project state, operation declarations, human operation calls, undo and redo, and the history. */
    csApi: CsApi;
  }
}

/** Configuration of the API plugin. */
export interface Config {
  /** Milliseconds between keep-alive comments on the event stream; at least 1000. */
  keepaliveMs: number;
}

/** Runtime schema of {@link Config}. */
export const Config: z<Config> = z.object({
  keepaliveMs: z.natural().min(1000).default(15_000),
});

/** The path below the web root where the event stream is served. */
export const EVENTS_PATH = "/cs/events";

/** The Fetch route paths, below the Connection's `/api` channel. */
export const ROUTES = {
  projects: "/api/cs/projects",
  untitled: "/api/cs/projects/untitled",
  projectSummaries: "/api/cs/projects/summary",
  projectRename: "/api/cs/projects/rename",
  projectDelete: "/api/cs/projects/delete",
  state: "/api/cs/state",
  operations: "/api/cs/operations",
  operation: "/api/cs/operation",
  operationCheck: "/api/cs/operation/check",
  undo: "/api/cs/undo",
  redo: "/api/cs/redo",
  acceptStale: "/api/cs/stale/accept",
  history: "/api/cs/history",
  catalog: "/api/cs/catalog",
} as const;

/**
 * The JSON body of a request, or an empty object when the body is absent or not JSON.
 * @param request - the request.
 * @returns the parsed body.
 */
async function bodyOf(request: Request): Promise<unknown> {
  try {
    const body: unknown = await request.json();
    return body;
  } catch {
    // A missing or malformed body is reported by the handler as a missing field, not as a transport failure.
    return {};
  }
}

/**
 * @param request - a request.
 * @param name - a query parameter.
 * @returns its value, or null when the request URL lacks it.
 */
function query(request: Request, name: string): string | null {
  return new URL(request.url).searchParams.get(name);
}

/** The API service. */
export default class CsApi extends Service {
  static inject = ["csProject"];
  static Config = Config;

  /** The transport-independent route handlers. */
  readonly api: ApiHandlers;

  private readonly config: Config;
  /** The end function of every open event stream. */
  private readonly streams = new Set<() => void>();
  /** The generation catalog while one is mounted. */
  private catalog: CsCatalog | undefined;
  /** What every open event stream wants to hear when the catalog changed. */
  private readonly catalogListeners = new Set<() => void>();

  constructor(ctx: Context, config: Config) {
    super(ctx, "csApi");
    this.config = Config(config);
    this.api = new ApiHandlers(ctx.csProject, () => this.catalog);
    // The catalog is optional: the API serves projects without one. Its arrival and its departure are changes too.
    ctx.inject(["csCatalog"], (cataloged) => {
      cataloged.effect(() => {
        const catalog = cataloged.csCatalog;
        this.catalog = catalog;
        const unlisten = catalog.onChanged(() => {
          this.catalogChanged();
        });
        this.catalogChanged();
        return () => {
          unlisten();
          if (this.catalog === catalog) this.catalog = undefined;
          this.catalogChanged();
        };
      }, "csApi catalog");
    });
    ctx.inject(["connection"], (connected) => {
      for (const route of this.fetchRoutes()) {
        connected.effect(() => {
          const dispose = connected.connection.fetch.register(route);
          return () => {
            void dispose();
          };
        }, `csApi ${route.path}`);
      }
    });
    // The stream needs Connection to tell whose request it is; without one it is not served at all.
    ctx.inject(["webServer", "connection"], (web) => {
      web.effect(() => {
        const dispose = web.webServer.register({
          kind: "exact",
          path: EVENTS_PATH,
          handler: (request, response) => {
            this.serveEvents(web, request, response);
          },
        });
        return () => {
          dispose();
          // An open stream would stay subscribed to a service that is going away and never speak again. Ending it
          // makes the browser connect anew, to whatever serves the path then.
          // Each end removes its own entry; a Set may shrink while it is iterated.
          for (const end of this.streams) end();
        };
      }, `csApi ${EVENTS_PATH}`);
    });
  }

  /** @returns the Fetch routes in path order. */
  fetchRoutes(): ConnectionFetchRoute[] {
    const api = this.api;
    /** Answer with the JSON value of `run`, and log a failure nobody expected. */
    const reply = (run: () => unknown): Promise<Response> =>
      answer(run, (error) => {
        this.ctx.logger("csApi").warn(error);
      });
    /** A GET route that answers with the JSON value of `run`. */
    const get = (path: string, run: (request: Request) => unknown): ConnectionFetchRoute => ({
      path,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: (request) => reply(() => run(request)),
    });
    /** A POST route that answers with the JSON value of `run`, called with the request's JSON body. */
    const post = (path: string, run: (body: unknown) => unknown): ConnectionFetchRoute => ({
      path,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        const body = await bodyOf(request);
        return reply(() => run(body));
      },
    });
    return [
      {
        path: ROUTES.projects,
        methods: ["GET", "POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          if (request.method === "GET") return reply(() => api.listProjects());
          const body = await bodyOf(request);
          return reply(() => api.createProject(body));
        },
      },
      post(ROUTES.untitled, (body) => api.untitledFolder(body)),
      get(ROUTES.projectSummaries, (request) =>
        api.listProjectSummaries(query(request, "project")),
      ),
      post(ROUTES.projectRename, (body) => api.renameProject(body)),
      post(ROUTES.projectDelete, (body) => api.removeProject(body)),
      get(ROUTES.state, (request) => api.getState(query(request, "project"))),
      get(ROUTES.operations, () => api.listOperations()),
      post(ROUTES.operation, (body) => api.runOperation(body)),
      post(ROUTES.operationCheck, (body) => api.checkOperation(body)),
      post(ROUTES.undo, (body) => api.undo(body)),
      post(ROUTES.redo, (body) => api.redo(body)),
      post(ROUTES.acceptStale, (body) => api.acceptStale(body)),
      post(ROUTES.history, (body) => api.listHistory(body)),
      get(ROUTES.catalog, () => api.listCatalog()),
    ];
  }

  /** Tell every open stream that the catalog changed. */
  private catalogChanged(): void {
    for (const listener of this.catalogListeners) listener();
  }

  /**
   * Serve `/cs/events?project=<id>`: refuse a method other than GET (405) and requests Connection does not admit as
   * the owner (401 or 403, with no body, as dsh answers them), answer the JSON error body of the Fetch routes for a
   * malformed project (400 `invalid_params`) or an unknown one (404 `unknown_project`), else stream the project's
   * changes. Admission is checked when the stream opens; the stream ends with the plugin.
   * @param web - the context that holds the web server and the Connection.
   * @param request - the HTTP request.
   * @param response - the HTTP response.
   */
  private serveEvents(web: Context, request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end();
      return;
    }
    const admission = web.connection.admit({ headers: request.headers });
    if ("rejection" in admission) {
      response.writeHead(admission.rejection).end();
      return;
    }
    // Exact Fetch routes reach only the owner; the stream follows the same rule. The kind is read as a plain string
    // because other packages may merge more principal kinds into dsh's map.
    const principal: string = admission.peer.principal.kind;
    if (principal !== "owner") {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    let projectId: ProjectId;
    try {
      projectId = requireProject(this.ctx.csProject, url.searchParams.get("project"));
    } catch (error) {
      if (!(error instanceof ApiRequestError)) throw error;
      response
        .writeHead(error.status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(JSON.stringify({ error: error.message, code: error.code }));
      return;
    }
    const end = serveEventStream(projectId, request, response, {
      subscribe: (id, listener) => this.ctx.csProject.subscribe(id, listener),
      subscribeCatalog: (listener) => {
        this.catalogListeners.add(listener);
        return () => {
          this.catalogListeners.delete(listener);
        };
      },
      keepaliveMs: this.config.keepaliveMs,
      onEnd: () => this.streams.delete(end),
    });
    this.streams.add(end);
  }
}
