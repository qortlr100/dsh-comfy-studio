// The left navigator: home, then every project with its chat sessions. Replaces dsh's workspace
// browser (`sidebar.workspaces`). Behaviour follows docs/archive/PLAN_3-0.md "만들 것".

import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconEllipsisOutlineRegular,
  IconPlusOutlineRegular,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ShellActions, ShellInjected } from "./contract.ts";
import styles from "./Navigator.module.css";
import { projectSessions, visibleSessions } from "./navigation.ts";
import { strings } from "./strings.ts";

type NavigatorProps = PropsRuntime<"sidebar.workspaces"> & InjectFace<ShellInjected>;

type ProjectBlockProps = {
  project: { id: string; title: string };
  open: boolean;
  actions: ShellActions;
  currentSessionId: string | undefined;
  useWorkspaces: NavigatorProps["useWorkspaces"];
  useSessions: NavigatorProps["useSessions"];
};

/** The "⋯" menu of a project row: closes on Escape and on a press outside it. */
function ProjectMenu(props: { onRename: () => void; onRemove: () => void }): JSX.Element {
  const { onRename, onRemove } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <span ref={wrapRef}>
      <button
        type="button"
        className={`${styles.iconButton} ${styles.trailing}`}
        data-cs-project-menu=""
        aria-label={strings.projectMenu}
        title={strings.projectMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconEllipsisOutlineRegular size={16} />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            data-cs-action="rename"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            {strings.rename}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.danger}`}
            data-cs-action="remove"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            {strings.removeProject}
          </button>
        </div>
      )}
    </span>
  );
}

/** The inline title editor: Enter or blur saves, Escape cancels. */
function RenameField(props: {
  title: string;
  onSave: (value: string) => void;
  onDone: () => void;
}): JSX.Element {
  const { title, onSave, onDone } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (save: boolean, value: string): void => {
    if (settled.current) return;
    settled.current = true;
    if (save) onSave(value);
    onDone();
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className={styles.renameInput}
      data-cs-rename=""
      aria-label={strings.renameProjectLabel}
      defaultValue={title}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true, event.currentTarget.value);
        else if (event.key === "Escape") finish(false, "");
      }}
      onBlur={(event) => finish(true, event.currentTarget.value)}
    />
  );
}

/** The chat sessions of one project. Mounted only while the project is expanded. */
function SessionRows(props: ProjectBlockProps): JSX.Element {
  const { project, open, actions, currentSessionId, useWorkspaces, useSessions } = props;
  const workspace = useWorkspaces((state) =>
    state.items.find((item) => item.workspaceId === project.id),
  );
  const archived = useWorkspaces((state) => state.archivedSessionIds);
  const byId = useSessions((state) => state.byId);
  const rows = useMemo(
    () => visibleSessions(projectSessions(workspace, byId, archived), currentSessionId),
    [workspace, byId, archived, currentSessionId],
  );

  return (
    <div className={styles.sessions}>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className={styles.session}
          data-cs-session={row.id}
          data-active={open && row.id === currentSessionId ? "" : undefined}
          onClick={() => {
            if (open) actions.openSession(row.id);
            else actions.openProject(project.id, row.id);
          }}
        >
          {row.blank ? strings.newChat : row.displayTitle}
        </button>
      ))}
    </div>
  );
}

/** One project: its row, its menu, its rename field, its removal dialog and its chat list. */
function ProjectBlock(props: ProjectBlockProps): JSX.Element {
  const { project, open, actions } = props;
  // The user's own fold of the chat list, remembered with the `open` it was chosen under.
  // Opening or leaving the project makes it stale, so an opened project always shows its chats.
  const [fold, setFold] = useState<{ open: boolean; folded: boolean } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const showChats = fold !== null && fold.open === open ? !fold.folded : open;

  return (
    <div
      className={styles.project}
      data-cs-project={project.id}
      data-active={open ? "" : undefined}
    >
      <div className={styles.projectRow}>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.caret}`}
          data-cs-chats-toggle=""
          aria-expanded={showChats}
          aria-label={showChats ? strings.hideChats : strings.showChats}
          title={showChats ? strings.hideChats : strings.showChats}
          onClick={() => setFold({ open, folded: showChats })}
        >
          {showChats ? (
            <IconChevronDownOutlineRegular size={14} />
          ) : (
            <IconChevronRightOutlineRegular size={14} />
          )}
        </button>
        {renaming ? (
          <RenameField
            title={project.title}
            onSave={(value) => actions.renameProject(project.id, value)}
            onDone={() => setRenaming(false)}
          />
        ) : (
          <button
            type="button"
            className={styles.title}
            data-cs-project-open=""
            title={project.title}
            onClick={() => actions.openProject(project.id)}
          >
            {project.title}
          </button>
        )}
        <ProjectMenu onRename={() => setRenaming(true)} onRemove={() => setConfirming(true)} />
        <button
          type="button"
          className={`${styles.iconButton} ${styles.trailing}`}
          data-cs-new-chat=""
          aria-label={strings.newChat}
          title={strings.newChat}
          onClick={() => actions.newChat(project.id)}
        >
          <IconPlusOutlineRegular size={16} />
        </button>
      </div>
      {showChats && <SessionRows {...props} />}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={strings.removeConfirmTitle}
        closeLabel={strings.cancel}
        footer={
          <div className={styles.confirmFooter}>
            <Button
              variant="outline"
              size="sm"
              data-cs-confirm-cancel=""
              data-modal-autofocus=""
              onClick={() => setConfirming(false)}
            >
              {strings.cancel}
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-cs-confirm-remove=""
              onClick={() => {
                setConfirming(false);
                actions.removeProject(project.id);
              }}
            >
              {strings.remove}
            </Button>
          </div>
        }
      >
        <p className={styles.confirmBody}>{strings.removeConfirmBody(project.title)}</p>
      </Modal>
    </div>
  );
}

/** The navigator. Renders nothing in the collapsed rail. */
export function Navigator({
  wide,
  actions,
  useShell,
  useWorkspaces,
  useSessions,
  usePanelInfo,
}: NavigatorProps): JSX.Element | null {
  const projects = useShell((state) => state.projects);
  const projectId = useShell((state) => state.projectId);
  const sessionId = useShell((state) => state.sessionId);
  const activePanelId = usePanelInfo((info) => info.activePanelId);
  const sorted = useMemo(
    () => projects?.toSorted((a, b) => b.created_at.localeCompare(a.created_at)) ?? null,
    [projects],
  );

  if (!wide) return null;
  const homeActive = projectId === null && activePanelId === null;

  return (
    <nav className={styles.root} data-cs-navigator="">
      <button
        type="button"
        className={styles.homeRow}
        data-cs-nav-home=""
        data-active={homeActive ? "" : undefined}
        aria-current={homeActive ? "page" : undefined}
        onClick={actions.goHome}
      >
        {strings.home}
      </button>
      <div className={styles.label}>{strings.projects}</div>
      {sorted === null && <div className={styles.note}>{strings.loadingProjects}</div>}
      {sorted?.length === 0 && (
        <div className={styles.note} data-cs-nav-empty="">
          {strings.noProjects}
        </div>
      )}
      {sorted?.map((project) => (
        <ProjectBlock
          key={project.id}
          project={project}
          open={project.id === projectId}
          actions={actions}
          currentSessionId={sessionId}
          useWorkspaces={useWorkspaces}
          useSessions={useSessions}
        />
      ))}
    </nav>
  );
}
