// Browser half of the shell: our brand, navigator and center in place of dsh's, the chat as a
// right-panel tab. This entry exports `inject` and `apply` only. `ctx` stays in this file, in
// host.ts (the one reader of dsh services for actions.ts and follow.ts, whose `ctx` wrappers are
// one line each), views.ts and chrome.ts; React components get what they need through the
// registrations' `inject` factory (docs/DSH.md "업스트림의 브라우저 코드 규칙").
// Design: docs/archive/PLAN_3-0.md.

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type { SidebarRightTabDefinition } from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import { createActions, projectReader } from "./actions.ts";
import { createShellClient } from "./api.ts";
import { BrandMark, BrandName } from "./Brand.tsx";
import { Center } from "./Center.tsx";
import { ChatTab } from "./ChatTab.tsx";
import { applyChrome } from "./chrome.ts";
import type { ShellInjected } from "./contract.ts";
import { FailureToast } from "./FailureToast.tsx";
import { followShell } from "./follow.ts";
import { CHAT_TAB_ID, CHAT_TAB_KIND, FAILURE_TOAST_ID } from "./ids.ts";
import { Navigator } from "./Navigator.tsx";
import { NewProjectButton } from "./NewProjectButton.tsx";
import { createShellStore } from "./store.ts";
import { strings } from "./strings.ts";
import { followCenterViews } from "./views.ts";

export const inject = [
  "slots",
  "sidebarRightTabs",
  "sidebarRight",
  "workspaces",
  "sessions",
  "uiWorkspace",
  "layout",
];

const chatTab: SidebarRightTabDefinition = {
  id: CHAT_TAB_ID,
  kind: CHAT_TAB_KIND,
  priority: "builtin",
  // The composer keeps its draft and its binding to the session editor while another tab shows.
  keepMounted: true,
  title: () => strings.chat,
  guide: [
    {
      id: CHAT_TAB_KIND,
      order: 30,
      title: () => strings.chat,
      description: () => strings.chatDescription,
    },
  ],
};

export function apply(ctx: Context): void {
  const store = createShellStore();
  const client = createShellClient();
  // One project-list read for the actions and the subscriptions, so they count reads together.
  const readProjects = projectReader(store, client);
  const actions = createActions(ctx, store, client, readProjects);

  // Before any registration: dsh must not reach its first-use start with its own behaviour.
  applyChrome(ctx);

  // One face for every registration, so the navigator, the center and the toast read one state.
  const injected: ShellInjected = {
    actions,
    hooks: { shell: store, views: followCenterViews(ctx) },
  };
  const face = (): ShellInjected => injected;

  // The center, with the slot other packages register their project views in.
  ctx.slots.inject("main.conversation", () =>
    ctx.slots.register(
      {
        name: "main.conversation",
        priority: -1,
        inject: face,
        children: { "cs.center.view": { kind: "list", scope: "root" } },
      },
      Center,
    ),
  );

  ctx.slots.inject("sidebar.workspaces", () =>
    ctx.slots.register({ name: "sidebar.workspaces", priority: -1, inject: face }, Navigator),
  );
  ctx.slots.inject("sidebar.session.action", () =>
    ctx.slots.register(
      { name: "sidebar.session.action", id: "cs-new-project", inject: face },
      NewProjectButton,
    ),
  );
  ctx.slots.inject("sidebar.brand.name", () =>
    ctx.slots.register({ name: "sidebar.brand.name", priority: -1 }, BrandName),
  );
  ctx.slots.inject("sidebar.brand.mark", () =>
    ctx.slots.register({ name: "sidebar.brand.mark", priority: -1 }, BrandMark),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: FAILURE_TOAST_ID, inject: face }, FailureToast),
  );

  // The chat lives in the right panel only: one conversation body per session.
  ctx.effect(() => ctx.sidebarRightTabs.register(chatTab));
  ctx.slots.inject("sidebar.right.pane.tab", () =>
    ctx.slots.register({ name: "sidebar.right.pane.tab", key: CHAT_TAB_ID }, ChatTab),
  );

  followShell(ctx, store, readProjects);
}
