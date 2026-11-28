// The views registered in `cs.center.view`, mirrored as a list the project frame can draw tabs
// from. The frame cannot ask the slot registry itself: React components never see `ctx`.

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { StoredEntry } from "@deepseek-ai/dsh-client-ui-slots";
import type { CenterViewTab, Observable } from "./contract.ts";
import { CENTER_VIEW_SLOT } from "./ids.ts";

/**
 * Turn slot entries into tabs: entries with an id, in `order`, with the label they registered.
 * The label is passed on unresolved: a label function may follow the interface language, so the
 * frame resolves it on every render.
 * @param entries - the live entries of the slot.
 * @returns the tabs.
 */
export function tabsOf(entries: readonly Pick<StoredEntry, "options">[]): CenterViewTab[] {
  const rows: (CenterViewTab & { order: number })[] = [];
  for (const { options } of entries) {
    const id = options.id;
    if (id === undefined || id === "") continue;
    rows.push({ id, order: options.order ?? 0, label: options.label });
  }
  return rows.toSorted((a, b) => a.order - b.order).map(({ id, label }) => ({ id, label }));
}

function sameTabs(a: readonly CenterViewTab[], b: readonly CenterViewTab[]): boolean {
  return (
    a.length === b.length && a.every((tab, i) => tab.id === b[i]?.id && tab.label === b[i]?.label)
  );
}

/**
 * Follow the registrations of `cs.center.view` for as long as the plugin lives.
 * @param ctx - the client context; the subscription ends with it.
 * @returns the tabs as an observable whose snapshot keeps its identity until the tabs change.
 */
export function followCenterViews(ctx: Context): Observable<readonly CenterViewTab[]> {
  let tabs: readonly CenterViewTab[] = [];
  const listeners = new Set<() => void>();
  const sync = (): void => {
    const next = tabsOf(ctx.slots.entriesOfSlot(CENTER_VIEW_SLOT));
    if (sameTabs(next, tabs)) return;
    tabs = next;
    for (const listener of Array.from(listeners)) listener();
  };
  ctx.effect(() => ctx.slots.subscribe(CENTER_VIEW_SLOT, sync));
  sync();
  return {
    getSnapshot: () => tabs,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
