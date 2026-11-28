// Types only: what the shell's modules share with each other, and the slot the shell declares
// for the views other packages draw in the center. Spec: docs/archive/PLAN_3-0.md "만들 것".

import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type { WireProject } from "@cs/api/wire";

/** A value with the two members the slot renderer turns into a `use<Name>(selector)` hook. */
export interface Observable<T> {
  /** The same reference until the next change. */
  getSnapshot(this: void): T;
  subscribe(this: void, listener: () => void): () => void;
}

/** A failed shell action on display. `seq` grows with every report, so a repeat shows again. */
export interface ShellFailure {
  readonly seq: number;
  readonly message: string;
}

/** What the navigator, the center and the toast share. One object per change. */
export interface ShellState {
  /** Every project, as `GET /api/cs/projects` lists them; null before the first read. */
  readonly projects: readonly WireProject[] | null;
  /** The project open in the center; null on the home page. A project id is a dsh workspace id. */
  readonly projectId: string | null;
  /** The dsh main session as the center last reported it. */
  readonly sessionId: string | undefined;
  /**
   * Grows each time a navigation the user started has brought the session it ends on to the
   * screen. The chat tab opens once for every request, and once for a session's first mount.
   */
  readonly chatRequest: number;
  readonly failure: ShellFailure | null;
}

/** The shell state store. `set` notifies only when a field changed (`Object.is`). */
export interface ShellStore extends Observable<ShellState> {
  set(this: void, patch: Partial<ShellState>): void;
}

/** The view API calls the shell makes. Rejects with `ApiError` (api.ts) on a non-2xx answer. */
export interface ShellClient {
  listProjects(): Promise<WireProject[]>;
  /** Creates a project folder and registers it; the server numbers a title that is taken. */
  createProject(title: string): Promise<WireProject>;
  /** Resolves to the title the server stored. */
  renameProject(projectId: string, title: string): Promise<string>;
  /** Takes the project off the list; its folder stays on disk. */
  removeProject(projectId: string): Promise<void>;
}

/**
 * What the React components may do. Every action returns at once; a failure ends up in
 * `ShellState.failure` instead of a rejected promise, so a component never has to catch.
 */
export interface ShellActions {
  /** Create a project and open it. */
  newProject(this: void): void;
  /** Open a project in the center and move the dsh main session into it. */
  openProject(this: void, projectId: string, sessionId?: string): void;
  /** Make one chat session the dsh main session. */
  openSession(this: void, sessionId: string): void;
  /** Open the project's blank chat session, creating one when it has none. */
  newChat(this: void, projectId: string): void;
  /** Show the home page. */
  goHome(this: void): void;
  renameProject(this: void, projectId: string, title: string): void;
  removeProject(this: void, projectId: string): void;
  /** Expand the right panel on the chat tab of the main session, opening one when there is none. */
  showChat(this: void): void;
  /** The center reports the dsh main session it was rendered for. */
  noteMainSession(this: void, sessionId: string | undefined): void;
  /** The toast reports that the failure with this `seq` has faded. */
  dismissFailure(this: void, seq: number): void;
}

/** One registered view of the open project, as the frame's view switch shows it. */
export interface CenterViewTab {
  /** The entry id; `renderSlot`'s `only` selects it. */
  readonly id: string;
  /** As registered; resolve it with `resolveSlotLabel` on every render (it may follow the locale). */
  readonly label: string | (() => string) | undefined;
}

/** What every shell registration's `inject` factory hands over. Built once in `apply`. */
export interface ShellInjected {
  actions: ShellActions;
  /** Reach a component as `useShell(selector)` and `useViews(selector)`. */
  hooks: { shell: Observable<ShellState>; views: Observable<readonly CenterViewTab[]> };
}

/** What the project frame hands the view it shows. */
export interface CenterViewProps {
  projectId: string;
  /** The main session when it belongs to the project, else null. Views record it on their edits. */
  sessionId: string | null;
}

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    /**
     * One view of the open project, such as the gallery. Declared by the shell's
     * `main.conversation` entry; the shell draws the entries in `order` and names none of them.
     */
    "cs.center.view": { kind: "list"; scope: "root"; owner: CenterViewProps };
  }
}
