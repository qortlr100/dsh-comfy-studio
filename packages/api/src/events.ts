/**
 * A project's changes as a server-sent event stream: one event per Project change, named by its kind (`record` for an
 * appended record, `update` for a record update, `line` for a move of the current position or the last step), a
 * `catalog` event with no data whenever the generation catalog changed, and a comment line every keep-alive interval
 * so proxies keep the response open.
 *
 * @module @cs/api/events
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectEvent, ProjectId } from "@cs/project";

/** What the stream needs from its owner. */
export interface EventStreamSources {
  subscribe(projectId: ProjectId, listener: (event: ProjectEvent) => void): () => void;
  /** Listen to changes of the generation catalog; absent when the owner has none to report. */
  subscribeCatalog?(listener: () => void): () => void;
  /** Milliseconds between keep-alive comments. */
  keepaliveMs: number;
  /** Called once when the stream ends, whoever ended it. */
  onEnd?(): void;
}

/**
 * The most bytes a stream may hold for a client that has stopped reading. Past it the stream ends; the browser's
 * `EventSource` connects again and the view reads the state anew, so nothing is lost.
 */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Serialize one Project change as an SSE frame named by its kind.
 * @param event - the change.
 * @returns the frame text.
 */
export function frameOf(event: ProjectEvent): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * The frame that says the generation catalog changed. It carries no data: a view reads the catalog anew.
 */
export const CATALOG_FRAME = "event: catalog\ndata: {}\n\n";

/**
 * Serve one project's changes until the client disconnects or the owner ends the stream.
 * @param projectId - the project.
 * @param request - the HTTP request; its close ends the subscription.
 * @param response - the HTTP response kept open for the stream.
 * @param sources - the subscription, the keep-alive interval and the end callback.
 * @returns a function that ends the stream: it stops the subscription and the keep-alive and closes the response.
 *   Calling it again does nothing.
 */
export function serveEventStream(
  projectId: ProjectId,
  request: IncomingMessage,
  response: ServerResponse,
  sources: EventStreamSources,
): () => void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let ended = false;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeCatalog: (() => void) | undefined;
  let keepalive: NodeJS.Timeout | undefined;
  const end = (): void => {
    // The request and the response both close, and the owner may end the stream too; only the first call acts.
    if (ended) return;
    ended = true;
    clearInterval(keepalive);
    unsubscribe?.();
    unsubscribeCatalog?.();
    response.end();
    sources.onEnd?.();
  };
  const write = (text: string): void => {
    if (ended) return;
    response.write(text);
    // A client that stopped reading must not grow the buffer without bound.
    if (response.writableLength > MAX_BUFFERED_BYTES) end();
  };
  write(`: connected ${projectId}\n\n`);
  // A named event (comments are invisible to EventSource) lets the browser tell a live stream from a buffered one.
  write("event: ready\ndata: {}\n\n");
  // A stream that already ended must not subscribe: nothing would ever release the subscription.
  if (ended) return end;
  unsubscribe = sources.subscribe(projectId, (event) => {
    write(frameOf(event));
  });
  unsubscribeCatalog = sources.subscribeCatalog?.(() => {
    write(CATALOG_FRAME);
  });
  keepalive = setInterval(() => {
    write(": keepalive\n\n");
  }, sources.keepaliveMs);
  request.on("close", end);
  response.on("close", end);
  return end;
}
