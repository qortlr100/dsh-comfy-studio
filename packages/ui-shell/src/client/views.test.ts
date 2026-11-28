import { describe, expect, test } from "vitest";
import { tabsOf } from "./views.ts";

const galleryLabel = (): string => "갤러리";

describe("tabsOf", () => {
  test("orders entries by `order` and keeps registration order for ties", () => {
    const tabs = tabsOf([
      { options: { id: "workflows", order: 20, label: "워크플로" } },
      { options: { id: "gallery", order: 10, label: "갤러리" } },
      { options: { id: "batches", order: 20, label: "배치" } },
    ]);
    expect(tabs).toEqual([
      { id: "gallery", label: "갤러리" },
      { id: "workflows", label: "워크플로" },
      { id: "batches", label: "배치" },
    ]);
  });

  test("an entry without `order` sorts as 0", () => {
    const tabs = tabsOf([
      { options: { id: "late", order: 1 } },
      { options: { id: "plain" } },
      { options: { id: "early", order: -1 } },
    ]);
    expect(tabs.map((tab) => tab.id)).toEqual(["early", "plain", "late"]);
  });

  test("labels pass through unresolved, so a label function can follow the locale", () => {
    const tabs = tabsOf([
      { options: { id: "gallery", label: galleryLabel } },
      { options: { id: "history" } },
    ]);
    expect(tabs).toEqual([
      { id: "gallery", label: galleryLabel },
      { id: "history", label: undefined },
    ]);
  });

  test("entries without an id cannot be selected and are left out", () => {
    expect(tabsOf([{ options: { label: "이름 없음" } }, { options: { id: "" } }])).toEqual([]);
  });
});
