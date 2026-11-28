// The center of the main conversation slot: the home page, or the frame of the open project.

import { useEffect } from "react";
import type { InjectFace, PropsRenderSlots, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ShellInjected } from "./contract.ts";
import { Home } from "./Home.tsx";
import { ProjectFrame } from "./ProjectFrame.tsx";

export type CenterProps = PropsRuntime<"main.conversation"> &
  PropsRenderSlots<"cs.center.view"> &
  InjectFace<ShellInjected>;

/**
 * Report the main session and draw the home page or the open project.
 * @param props - the slot props with the shell's actions and hooks.
 * @returns the page.
 */
export function Center({
  sessionId,
  actions,
  useShell,
  useViews,
  useWorkspaces,
  renderSlot,
}: CenterProps) {
  const projectId = useShell((state) => state.projectId);
  useEffect(() => {
    actions.noteMainSession(sessionId);
  }, [actions, sessionId]);
  if (projectId === null) {
    return <Home actions={actions} useShell={useShell} />;
  }
  return (
    <ProjectFrame
      key={projectId}
      projectId={projectId}
      sessionId={sessionId}
      actions={actions}
      useShell={useShell}
      useViews={useViews}
      useWorkspaces={useWorkspaces}
      renderSlot={renderSlot}
    />
  );
}
