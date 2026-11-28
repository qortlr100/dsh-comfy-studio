// The view API calls the shell makes (docs/ARCHITECTURE.md "화면용 API").

import type { WireProject } from "@cs/api/wire";
import type { ShellClient } from "./contract.ts";
import { strings } from "./strings.ts";

/** A non-2xx answer. `code` is the server's, or `http_error` when the body is not ours. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProject(value: unknown): value is WireProject {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["created_at"] === "string" &&
    typeof value["path"] === "string"
  );
}

function isProjectList(value: unknown): value is WireProject[] {
  return Array.isArray(value) && value.every(isProject);
}

/** The message is shown to the user; the path goes to the console with the failed action. */
function malformed(path: string): Error {
  return new Error(strings.unexpectedAnswer, { cause: `unexpected answer from ${path}` });
}

async function failure(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (isRecord(body) && typeof body["error"] === "string" && typeof body["code"] === "string") {
    return new ApiError(response.status, body["code"], body["error"]);
  }
  return new ApiError(response.status, "http_error", strings.requestFailed(response.status));
}

/**
 * The shell's client for the view API.
 * @param fetchImpl - `fetch`; tests pass a fake.
 * @returns the client. A non-2xx answer rejects with `ApiError`; a network failure propagates.
 */
export function createShellClient(fetchImpl: typeof fetch = fetch): ShellClient {
  async function call(path: string, body?: unknown): Promise<unknown> {
    const response =
      body === undefined
        ? await fetchImpl(path)
        : await fetchImpl(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
    if (!response.ok) throw await failure(response);
    try {
      return await response.json();
    } catch {
      throw malformed(path);
    }
  }
  return {
    async listProjects() {
      const answer = await call("/api/cs/projects");
      if (!isProjectList(answer)) throw malformed("/api/cs/projects");
      return answer;
    },
    async createProject(title) {
      const answer = await call("/api/cs/projects", { title, surface: "view" });
      if (!isProject(answer)) throw malformed("/api/cs/projects");
      return answer;
    },
    async renameProject(projectId, title) {
      const answer = await call("/api/cs/projects/rename", { project: projectId, title });
      if (!isRecord(answer) || typeof answer["title"] !== "string") {
        throw malformed("/api/cs/projects/rename");
      }
      return answer["title"];
    },
    async removeProject(projectId) {
      await call("/api/cs/projects/delete", { project: projectId });
    },
  };
}
