/**
 * The `agent/pre-step` listener of the project messages, through the `csProject` service with a stand-in session
 * projection registry: the listener reads the session's state through the handle that registration resolves to, adds
 * the project state message after the step's own messages, and leaves the step alone when registration failed or the
 * session has no project.
 */
import { join } from "node:path";
import { Context, type Events } from "@deepseek-ai/cordis";
import type { Agent, ModelSelection, PreStepDecision } from "@deepseek-ai/dsh-agent";
import { createUserMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import CsProject from "./index.ts";
import { PROJECT_MESSAGE_KIND, STATE_HEAD, type SessionSeen } from "./project-updates.ts";
import { standIn, tempRoot } from "./testing/support.ts";
import { chatProject, provideChatServices, type TestChatServices } from "./testing/workspaces.ts";

const SESSION = "s1";

const contexts: Context[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

interface Fixture {
  context: Context;
  services: TestChatServices;
  /** The sessions whose state the listener read through the handle. */
  reads: string[];
  /** Run the `agent/pre-step` waterfall for one step of `session`, as the agent loop does. */
  step(session: string, own: UserMessage[]): Promise<PreStepDecision>;
}

/**
 * Mount `csProject` beside a stand-in session projection registry.
 * @param register - what the registry's `register` resolves or rejects with; by default a handle whose state is
 *   `seen` for every session.
 * @param seen - the state the default handle answers.
 * @returns the fixture.
 */
async function start(
  register?: () => Promise<unknown>,
  seen: SessionSeen = { from: null },
): Promise<Fixture> {
  const context = new Context();
  contexts.push(context);
  const reads: string[] = [];
  let registrations = 0;
  const handle = {
    stateOf(session: { id: string }): SessionSeen {
      reads.push(session.id);
      return seen;
    },
  };
  const registry = {
    register(): Promise<unknown> {
      registrations += 1;
      return register === undefined ? Promise.resolve(handle) : register();
    },
  };
  context.provide("sessionProjections", standIn(registry));
  const services = provideChatServices(context);
  await context
    .plugin(CsProject, {
      projectsFolder: join(tempRoot(), "projects"),
      cpuConcurrency: 1,
      gpuConcurrency: 1,
      promptSectionOrder: 4900,
    })
    .await();
  await vi.waitFor(() => {
    expect(registrations).toBe(1);
  });
  return {
    context,
    services,
    reads,
    step: (session, own) => {
      // The agent loop dispatches the event with the agent as `this`, which scoped listeners filter on.
      const agent = standIn<Agent>({ id: session, session: { id: session } });
      return context.waterfall(
        standIn<ThisParameterType<Events["agent/pre-step"]>>(agent),
        "agent/pre-step",
        {
          agent,
          messages: own,
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
          modelSelection: standIn<ModelSelection>({}),
        },
        (): Promise<PreStepDecision> => Promise.resolve({ kind: "enter", messages: own }),
      );
    },
  };
}

const userMessage = (text: string): UserMessage =>
  createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });

const origin = {
  actor: "user" as const,
  surface: "view" as const,
  session: null,
  turn: null,
  tool_call: null,
  intent: "make the project",
};

describe("the pre-step listener of the project messages", () => {
  it("adds the project state message after the step's own messages, reading the session through the registration's handle", async () => {
    const fixture = await start();
    await chatProject(fixture.context.csProject, fixture.services, "Studio", origin, SESSION);
    const own = userMessage("hello");
    const decision = await fixture.step(SESSION, [own]);
    expect(decision.kind).toBe("enter");
    if (decision.kind !== "enter") return;
    expect(fixture.reads).toEqual([SESSION]);
    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[0]).toBe(own);
    const added = decision.messages[1];
    expect(added?.source.kind).toBe(PROJECT_MESSAGE_KIND);
    expect(added?.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(added?.content[0])).toContain(STATE_HEAD);
    expect(JSON.stringify(added?.content[0])).toContain("Studio");
  });

  it("leaves the step alone for a session without a project", async () => {
    const fixture = await start();
    const own = userMessage("hello");
    expect(await fixture.step("elsewhere", [own])).toEqual({ kind: "enter", messages: [own] });
  });

  it("leaves the step alone when the registry refused the projection", async () => {
    const fixture = await start(() => Promise.reject(new Error("the registry is closed")));
    await chatProject(fixture.context.csProject, fixture.services, "Studio", origin, SESSION);
    const own = userMessage("hello");
    expect(await fixture.step(SESSION, [own])).toEqual({ kind: "enter", messages: [own] });
    expect(fixture.reads).toEqual([]);
  });
});
