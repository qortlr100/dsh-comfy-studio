/**
 * Projects over the DSH Workspace registry: a project is a registered Workspace whose folder holds
 * `.comfy-studio/records.jsonl`, and its ID, title, creation time and path are the Workspace's. This module is the only
 * code that writes the registry, and it never deletes a file. Called by the service.
 *
 * @module @cs/project/folders
 */
import { existsSync, realpathSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId as ChatId } from "@deepseek-ai/dsh-session/types";
import { WorkspaceId, type Workspace, type WorkspaceRegistry } from "@deepseek-ai/dsh-workspace";
import { PROJECT_DIR, workspaceOfSession } from "./folder.ts";
import { ProjectError } from "./shared.ts";
import type { ProjectId, ProjectInfo } from "./types.ts";

/**
 * @param path - a path.
 * @returns its `realpath`, or undefined when it does not resolve.
 */
export function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    // `realpath` throws ENOENT for a missing path, and a missing folder belongs to no Workspace.
    return undefined;
  }
}

const isProject = (workspace: Workspace): boolean =>
  existsSync(join(workspace.path, PROJECT_DIR, "records.jsonl"));

const infoOf = (workspace: Workspace): ProjectInfo => ({
  id: brandString<ProjectId>(workspace.id),
  title: workspace.title,
  created_at: workspace.createdAt,
  path: workspace.path,
});

/** The projects of the Workspace registry; the service documents each operation. */
export class ProjectFolders {
  /** Serializes create, rename and remove, so two calls never register one folder twice or pick one free title. */
  private chain: Promise<unknown> = Promise.resolve();

  private readonly registry: Pick<
    WorkspaceRegistry,
    "list" | "get" | "create" | "delete" | "resolveByPath"
  >;
  private readonly parent: () => string;
  private readonly chats: () => Promise<ReadonlyArray<{ id: ChatId; cwd?: string | undefined }>>;
  private readonly warn: (message: string) => void;

  /**
   * @param registry - the DSH Workspace registry.
   * @param parent - the projects folder, which holds the folders of new projects.
   * @param chats - the stored and live top-level chat sessions with the working directory each header records.
   * @param warn - logs a chat session that could not be attached; the project stays created.
   */
  constructor(
    registry: Pick<WorkspaceRegistry, "list" | "get" | "create" | "delete" | "resolveByPath">,
    parent: () => string,
    chats: () => Promise<ReadonlyArray<{ id: ChatId; cwd?: string | undefined }>>,
    warn: (message: string) => void,
  ) {
    this.registry = registry;
    this.parent = parent;
    this.chats = chats;
    this.warn = warn;
  }

  list(): ProjectInfo[] {
    return this.registry
      .list()
      .filter(isProject)
      .map(infoOf)
      .toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  get(project: ProjectId): ProjectInfo {
    return infoOf(this.workspace(project));
  }

  ofFolder(cwd: string | undefined): ProjectId | null {
    const workspace: Workspace | undefined = workspaceOfSession(this.registry.list(), cwd);
    return workspace !== undefined && isProject(workspace)
      ? brandString<ProjectId>(workspace.id)
      : null;
  }

  async newFolder(name: string): Promise<string> {
    const base = name.replaceAll(/[/\\]/gu, "-").trim();
    if (base === "" || base === "." || base === "..")
      throw new ProjectError("invalid_params", "A project folder needs a name.");
    await mkdir(this.parent(), { recursive: true });
    for (let suffix = 1; ; suffix += 1) {
      const folder = join(this.parent(), suffix === 1 ? base : `${base} ${String(suffix)}`);
      try {
        await mkdir(folder);
        return folder;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
  }

  create(
    folder: string,
    title: string,
    writeFirst: (project: ProjectId, dir: string) => Promise<void>,
  ): Promise<ProjectInfo> {
    return this.serial(async () => {
      const path = await realpath(folder);
      const known = await this.registry.resolveByPath(path);
      const workspace = known ?? (await this.registry.create(path));
      const started = !isProject(workspace);
      if (started || known === undefined) await workspace.setTitle(title);
      if (started) {
        await writeFirst(brandString<ProjectId>(workspace.id), join(path, PROJECT_DIR));
        // Browsers read the project list again at each Workspace change; this one comes after the folder is a project.
        await workspace.setTitle(title);
      }
      for (const chat of await this.chats()) {
        if (chat.cwd === undefined || canonicalPath(chat.cwd) !== path) continue;
        await workspace.attachSession(chat.id).catch((error: unknown) => {
          this.warn(
            `could not attach chat ${chat.id} to project ${workspace.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return infoOf(workspace);
    });
  }

  rename(project: ProjectId, title: string): Promise<ProjectInfo> {
    return this.serial(async () => {
      const workspace = this.workspace(project);
      const wanted = title.trim();
      if (wanted.length === 0)
        throw new ProjectError("invalid_params", "A project title must not be empty.");
      const taken = new Set(
        this.list()
          .filter((info) => info.id !== project)
          .map((info) => info.title),
      );
      let unique = wanted;
      for (let suffix = 2; taken.has(unique); suffix += 1) unique = `${wanted} ${String(suffix)}`;
      await workspace.setTitle(unique);
      return infoOf(workspace);
    });
  }

  remove(project: ProjectId): Promise<void> {
    return this.serial(async () => {
      await this.registry.delete(WorkspaceId(project));
    });
  }

  private workspace(project: ProjectId): Workspace {
    const workspace = this.registry.get(WorkspaceId(project));
    if (workspace === undefined || !isProject(workspace))
      throw new ProjectError("unknown_project", `There is no project ${project}.`);
    return workspace;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    // The caller gets a rejection through `result`; the chain goes on after it.
    this.chain = result.catch(() => undefined);
    return result;
  }
}
