// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  isSidebarGestureIgnoredTarget,
  resolveHorizontalSwipe,
} from "@/lib/gestures/horizontal-swipe";

describe("resolveHorizontalSwipe", () => {
  it("recognizes left and right swipes with the shared distance rule", () => {
    expect(resolveHorizontalSwipe(200, 100, 130, 104)).toEqual({
      direction: "left",
      horizontalIntent: true,
    });
    expect(resolveHorizontalSwipe(100, 100, 170, 104)).toEqual({
      direction: "right",
      horizontalIntent: true,
    });
  });

  it("rejects short and vertically dominant movement", () => {
    expect(resolveHorizontalSwipe(100, 100, 140, 104)).toEqual({
      direction: null,
      horizontalIntent: true,
    });
    expect(resolveHorizontalSwipe(100, 100, 170, 190)).toEqual({
      direction: null,
      horizontalIntent: false,
    });
  });

  it("reserves horizontal scrollers and non-sidebar dialogs", () => {
    const scroller = document.createElement("div");
    scroller.dataset.mobileScrollAllow = "true";
    const scrollerChild = document.createElement("button");
    scroller.append(scrollerChild);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const dialogChild = document.createElement("button");
    dialog.append(dialogChild);

    expect(isSidebarGestureIgnoredTarget(scrollerChild)).toBe(true);
    expect(isSidebarGestureIgnoredTarget(dialogChild)).toBe(true);
  });

  it("allows coordinated mobile sidebars to replace one another", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const sidebar = document.createElement("aside");
    sidebar.dataset.sidebar = "sidebar";
    sidebar.dataset.mobile = "true";
    const sidebarChild = document.createElement("button");
    sidebar.append(sidebarChild);
    dialog.append(sidebar);

    expect(isSidebarGestureIgnoredTarget(sidebarChild)).toBe(false);
  });
});
