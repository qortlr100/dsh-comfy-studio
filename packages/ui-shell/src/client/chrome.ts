// THE ONE PLACE FOR DEVICES THAT LEAN ON DSH INTERNALS (docs/DSH.md "dsh 내부에 기대는 장치").
// None of these is a public dsh contract; each can break on a dsh upgrade. Re-check every one
// when following docs/DSH.md "버전 올리기", step 4. Decided by the user on 2026-11-28 (the
// minimum: only these two dsh behaviours are blocked; everything else of dsh stays).
//
// 1. No default workspace (service function override; this file).
//    dsh's first-use start (`restoreSelection` in upstream
//    packages/client/ui-workspace/src/client/navigation.ts) calls
//    `ctx.workspaces.initializeDefault(signal)` when there is no workspace and no session. That
//    creates `<Documents>/deepseek-harness/default-workspace`, a session outside every project, or
//    toasts "Unable to create default workspace" where there is no documents folder. For the
//    plugin's lifetime an own property on the service object shadows the prototype method and
//    resolves `undefined`, which `restoreSelection` handles as "nothing to open" (no target, no
//    session, no toast); deleting the own property restores the method.
//    Timing: nothing orders this plugin's `apply` before ui-workspace's (`dsh.client.inject`
//    edges do not order `apply`). It works because the first-use start waits for both host
//    lists to arrive, long after every `apply` ran; the integration test would show a change.
//    Re-check: `initializeDefault` is still a prototype method of the workspace controller's
//    client service (upstream packages/api/workspace-controller/src/client/service.ts), still
//    the only first-use call (grep `initializeDefault` in packages/client/ui-workspace), and an
//    `undefined` result still opens nothing. Live: start dsh with an empty home, no toast and no
//    default-workspace folder appear.
//
// 2. The sidebar brand does not start a session (CSS on dsh's class names; chrome.module.css).
//    The wide sidebar's brand is `<button class="<hash>_brand <hash>_wide" aria-label="New
//    session">` in `div.<hash>_logoRow` under `[data-slot="sidebar"]` (upstream
//    packages/client/ui-sidebar/src/client/SidebarRoot.tsx); its click calls `startSession()`,
//    which would leave the home page for the latest project's chat. A rule turns pointer events
//    off on it. Keyboard activation (Tab, Enter) still reaches the button.
//    Re-check: the brand is still a button with the `brand` local class in `SidebarRoot.tsx` and
//    `SidebarRoot.module.css`, the class pattern is still `[hash]_[local]`, and the collapsed rail
//    still draws no brand button. Live: clicking the brand name opens no session.

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client";
// Injects the rules of device 2 when the bundle's factory runs; there is no class to assign.
// oxlint-disable-next-line import/no-unassigned-import
import "./chrome.module.css";

/**
 * Install the devices above for the plugin's lifetime.
 * @param ctx - the client context with `workspaces`.
 */
export function applyChrome(ctx: Context): void {
  ctx.effect(() => {
    const workspaces = ctx.workspaces;
    Object.defineProperty(workspaces, "initializeDefault", {
      configurable: true,
      writable: true,
      value: (): Promise<undefined> => Promise.resolve(undefined),
    });
    return () => {
      Reflect.deleteProperty(workspaces, "initializeDefault");
    };
  });
}
