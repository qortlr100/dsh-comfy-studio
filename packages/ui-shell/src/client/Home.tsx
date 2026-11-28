// The page shown while no project is open: the projects as cards and the button to start one.

import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import type { ShellInjected } from "./contract.ts";
import styles from "./Center.module.css";
import { strings } from "./strings.ts";

export type HomeProps = Pick<InjectFace<ShellInjected>, "actions" | "useShell">;

/**
 * The home page.
 * @param props - the shell actions and state hook.
 * @returns the page.
 */
export function Home({ actions, useShell }: HomeProps) {
  const projects = useShell((state) => state.projects);
  const sorted = projects === null ? null : projects.toSorted(newestFirst);
  return (
    <div className={styles.page} data-cs-home="">
      <div className={styles.homeBody}>
        <div className={styles.homeHead}>
          <div>
            <h1 className={styles.homeTitle}>{strings.projects}</h1>
            <p className={styles.lead}>{strings.homeLead}</p>
          </div>
          <Button variant="primary" onClick={actions.newProject} data-cs-home-new-project="">
            {strings.newProject}
          </Button>
        </div>
        {sorted === null ? (
          <p className={styles.note}>{strings.loadingProjects}</p>
        ) : sorted.length === 0 ? (
          <p className={styles.note} data-cs-home-empty="">
            {strings.noProjects}
          </p>
        ) : (
          <div className={styles.cards}>
            {sorted.map((project) => (
              <button
                key={project.id}
                type="button"
                className={styles.card}
                data-cs-project-card={project.id}
                onClick={() => {
                  actions.openProject(project.id);
                }}
              >
                <span className={styles.cardTitle}>{project.title}</span>
                <span className={styles.cardMeta}>
                  {strings.createdOn(new Date(project.created_at).toLocaleDateString("ko-KR"))}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function newestFirst(a: { created_at: string }, b: { created_at: string }): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}
