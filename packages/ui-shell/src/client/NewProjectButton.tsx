// The sidebar's "new" button: dsh's New Session content is replaced by ours, which makes a project.

import {
  Button,
  IconPlusOutlineMedium,
  IconPlusOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ShellInjected } from "./contract.ts";
import styles from "./NewProjectButton.module.css";
import { strings } from "./strings.ts";

type Props = PropsRuntime<"sidebar.session.action"> & InjectFace<ShellInjected>;

/** Replaces `children` (dsh's New Session button) with a button that creates a project. */
export function NewProjectButton({ wide, actions }: Props): JSX.Element {
  if (!wide) {
    return (
      <Button
        variant="ghost"
        data-cs-new-project=""
        aria-label={strings.newProject}
        title={strings.newProject}
        onClick={actions.newProject}
      >
        <IconPlusOutlineRegular size={18} />
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      className={styles.wide}
      data-cs-new-project=""
      icon={<IconPlusOutlineMedium size={14} />}
      onClick={actions.newProject}
    >
      {strings.newProject}
    </Button>
  );
}
