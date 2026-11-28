// The page of an open project: a top bar and the area the registered views are drawn in.

import { useMemo, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { resolveSlotLabel } from "@deepseek-ai/dsh-client-ui-slots";
import type { InjectFace, PropsRenderSlots } from "@deepseek-ai/dsh-client-ui-slots";
import type { ShellInjected } from "./contract.ts";
import styles from "./Center.module.css";
import { CENTER_VIEW_SLOT } from "./ids.ts";
import { projectOfSession } from "./navigation.ts";
import { strings } from "./strings.ts";
import type { WorkspaceRow } from "./navigation.ts";

export interface ProjectFrameProps
  extends
    Pick<InjectFace<ShellInjected>, "actions" | "useShell" | "useViews">,
    PropsRenderSlots<"cs.center.view"> {
  projectId: string;
  /** The dsh main session, as the center received it. */
  sessionId: string | undefined;
  /** The slot's workspace hook; its items carry each workspace's session ids. */
  useWorkspaces: <S>(selector: (state: { items: readonly WorkspaceRow[] }) => S) => S;
}

/**
 * The frame of the open project.
 * @param props - the project, the main session and what the shell injects.
 * @returns the page.
 */
export function ProjectFrame({
  projectId,
  sessionId,
  actions,
  useShell,
  useViews,
  useWorkspaces,
  renderSlot,
}: ProjectFrameProps) {
  const projects = useShell((state) => state.projects);
  const tabs = useViews((views) => views);
  const items = useWorkspaces((state) => state.items);
  const [chosen, setChosen] = useState<string | null>(null);

  const title = projects?.find((project) => project.id === projectId)?.title ?? "";
  const selectedId = tabs.find((tab) => tab.id === chosen)?.id ?? tabs[0]?.id;
  const viewSessionId = useMemo(
    () => (projectOfSession(projects, items, sessionId) === projectId ? (sessionId ?? null) : null),
    [projects, items, sessionId, projectId],
  );

  return (
    <div className={styles.page} data-cs-project-frame={projectId}>
      <div className={styles.topbar}>
        <h1 className={styles.projectTitle} data-cs-project-title="">
          {title}
        </h1>
        {tabs.length >= 2 && (
          <div className={styles.tabs} role="tablist" aria-label={strings.views}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === selectedId}
                className={styles.tab}
                data-cs-view-tab={tab.id}
                onClick={() => {
                  setChosen(tab.id);
                }}
              >
                {resolveSlotLabel(tab.label) ?? tab.id}
              </button>
            ))}
          </div>
        )}
        <div className={styles.topbarEnd}>
          <Button variant="outline" size="sm" onClick={actions.showChat} data-cs-open-chat="">
            {strings.openChat}
          </Button>
        </div>
      </div>
      <div className={styles.viewArea}>
        {selectedId === undefined ? (
          <div className={styles.empty} data-cs-no-views="">
            <p className={styles.emptyTitle}>{strings.noViews}</p>
            <p className={styles.note}>{strings.noViewsHint}</p>
          </div>
        ) : (
          renderSlot(
            CENTER_VIEW_SLOT,
            { projectId, sessionId: viewSessionId },
            { only: selectedId },
          )
        )}
      </div>
    </div>
  );
}
