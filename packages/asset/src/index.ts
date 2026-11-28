/**
 * The asset feature component as the `csAsset` Cordis service. It registers itself as the project layer's asset store
 * (the files of each project live in its own folder: see `store.ts`), the `asset` component with its reducer (the
 * project's asset library) and operations, and, while dsh's Connection is mounted, the routes that serve and receive
 * asset files (`routes.ts`). The ffmpeg service `csFfmpeg` is optional: without it assets have no size, duration or
 * thumbnail.
 *
 * The store follows DreamVerse `@dv/asset-pool` (MIT, commit ec0ac62760).
 *
 * @module @cs/asset
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import z from "@deepseek-ai/schemastery";
import type {} from "@cs/ffmpeg";
import type { AssetId, ProjectId } from "@cs/project";
import { toolNameOf } from "@cs/project";
import { assetOperations } from "./operations.ts";
import { assetReducer } from "./reducer.ts";
import { assetRoutes } from "./routes.ts";
import { AssetFiles, probeMedia, type ImportMeta } from "./store.ts";
import { Thumbnails } from "./thumbs.ts";
import { ASSET_COMPONENT, type StoredAsset } from "./types.ts";

export * from "./types.ts";
export {
  AssetFiles,
  probeMedia,
  type AssetFilesDeps,
  type ImportMeta,
  type MediaFacts,
} from "./store.ts";
export { Thumbnails, type FfmpegPort } from "./thumbs.ts";
export { assetRoutes, type RouteDeps } from "./routes.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The asset feature component: the asset store, the library's operations and the file routes. */
    csAsset: CsAsset;
  }
}

/** `csAsset` plugin configuration. */
export interface Config {
  /** Base of the asset URLs that the agent and chat cards show, such as a tunnel origin; empty keeps them relative. */
  publicBaseUrl: string;
  /** The most bytes one upload may carry. */
  maxUploadBytes: number;
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  publicBaseUrl: z.string().default(""),
  maxUploadBytes: z
    .natural()
    .min(1)
    .default(2 * 1024 * 1024 * 1024),
});

/** The asset feature component. */
export default class CsAsset extends Service {
  static inject = ["csProject"];
  static Config = Config;

  private readonly files: AssetFiles;
  private readonly thumbs: Thumbnails;

  constructor(ctx: Context, config: Config) {
    super(ctx, "csAsset");
    const log = ctx.logger("csAsset");
    this.files = new AssetFiles({
      folderOf: (project) => ctx.csProject.openProject(project).path,
      folders: () => ctx.csProject.listProjects().map((info) => info.path),
      publicBaseUrl: config.publicBaseUrl,
    });
    this.thumbs = new Thumbnails({
      entry: (asset) => this.files.find(asset),
      path: (asset) => this.files.path(asset),
      thumbPath: (asset) => this.files.thumbPath(asset),
      ffmpeg: () => ctx.get("csFfmpeg"),
      warn: (message) => {
        log.warn(message);
      },
    });
    /** Add the media facts ffprobe reads to an asset; best effort, never rejects. */
    const probe = async (asset: AssetId): Promise<void> => {
      try {
        const ffmpeg = ctx.get("csFfmpeg");
        if (ffmpeg === undefined || !(await ffmpeg.available())) return;
        await probeMedia(this.files, ffmpeg, asset, (message) => {
          log.warn(message);
        });
      } catch (error) {
        log.warn(error);
      }
    };
    ctx.effect(
      () =>
        ctx.csProject.registerAssetStore({
          has: (asset) => this.files.has(asset),
          get: (asset) => this.files.facts(asset),
          read: (asset) => this.files.read(asset),
          url: (asset) => this.files.url(asset),
          importAsset: (project, source, meta, createdBy) => {
            const asset = this.files.importAsset(project, source, meta, createdBy);
            // An operation's output: read its pixel size and duration in the background. The import itself is
            // synchronous and never waits for ffprobe.
            void probe(asset);
            return asset;
          },
        }),
      "csAsset asset store",
    );
    ctx.effect(() => ctx.csProject.registerComponent(ASSET_COMPONENT), "csAsset component");
    ctx.effect(
      () => ctx.csProject.registerReducer(ASSET_COMPONENT, assetReducer),
      "csAsset reducer",
    );
    const specs = assetOperations({
      entry: (asset) => this.files.find(asset),
      path: (asset) => this.files.path(asset),
      url: (asset) => this.files.url(asset),
      toolOf: (operation) => {
        const spec = ctx.csProject
          .listOperations()
          .find((candidate) => candidate.name === operation);
        return spec === undefined || spec.agent === "none" ? null : toolNameOf({ name: operation });
      },
    });
    for (const spec of specs) {
      ctx.effect(() => ctx.csProject.registerOperation(spec), `csAsset ${spec.name}`);
    }
    ctx.inject(["connection"], (connected) => {
      const routes = assetRoutes({
        files: this.files,
        thumbs: this.thumbs,
        project: ctx.csProject,
        probe,
        maxUploadBytes: config.maxUploadBytes,
        onInternalError: (error) => {
          log.warn(error);
        },
      });
      for (const route of routes) {
        connected.effect(() => {
          const dispose = connected.connection.fetch.register(route);
          return async () => {
            await dispose();
          };
        }, `csAsset ${route.path}`);
      }
    });
  }

  /**
   * @param asset - an asset ID.
   * @returns the absolute path of the asset's bytes.
   * @throws ProjectError `unknown_asset`.
   */
  path(asset: AssetId): string {
    return this.files.path(asset);
  }

  /**
   * @param asset - an asset ID.
   * @returns the store's entry, or undefined when no project folder holds the asset.
   */
  find(asset: AssetId): StoredAsset | undefined {
    return this.files.find(asset);
  }

  /**
   * Store bytes in a project's folder without putting them in the asset library; another component's operation may take
   * the returned ID as an input.
   * @param project - the project.
   * @param source - the bytes, or the path of a file to copy in.
   * @param meta - the media type, the display name, and the media facts when known.
   * @returns the asset ID.
   * @throws ProjectError `unknown_project`.
   */
  stage(project: ProjectId, source: Uint8Array | { path: string }, meta: ImportMeta): AssetId {
    return this.files.importAsset(project, source, meta, null);
  }

  /**
   * @param asset - an asset ID.
   * @returns the path of the asset's thumbnail, made when needed; null when it has none.
   */
  thumbOf(asset: AssetId): Promise<string | null> {
    return this.thumbs.thumbOf(asset);
  }
}
