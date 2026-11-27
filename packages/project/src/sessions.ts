/**
 * The work a chat session's agent tool calls wait for, such as chat images still being imported.
 *
 * Calls nothing else in Project. Called by the service (`holdToolCalls`) and by the agent tools module.
 *
 * @module @cs/project/sessions
 */
import type { SessionId } from "./types.ts";

/** Held tool calls by session. */
export class Sessions {
  private readonly holds = new Map<SessionId, Promise<unknown>>();

  /**
   * Make the session's next tool calls wait until `work` settles, after any work held before it.
   * @param session - the chat session.
   * @param work - the work, such as importing the chat images of a message; its failure does not fail the calls.
   */
  hold(session: SessionId, work: Promise<unknown>): void {
    const settled = (): void => {
      if (this.holds.get(session) === held) this.holds.delete(session);
    };
    const previous = this.holds.get(session) ?? Promise.resolve();
    const held = Promise.allSettled([previous, work]);
    this.holds.set(session, held);
    held.then(settled, settled);
  }

  /**
   * @param session - the chat session.
   * @returns a promise that settles when the work held for the session settled.
   */
  async ready(session: SessionId): Promise<void> {
    await this.holds.get(session);
  }
}
