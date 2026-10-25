// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  isLauncherGestureIgnoredTarget,
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

    expect(isLauncherGestureIgnoredTarget(scrollerChild)).toBe(true);
    expect(isLauncherGestureIgnoredTarget(dialogChild)).toBe(true);
  });

  it("reserves editable controls for selection and cursor gestures", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const editorChild = document.createElement("span");
    editor.append(editorChild);
    const disabledEditor = document.createElement("div");
    disabledEditor.setAttribute("contenteditable", "false");

    expect(isLauncherGestureIgnoredTarget(input)).toBe(true);
    expect(isLauncherGestureIgnoredTarget(textarea)).toBe(true);
    expect(isLauncherGestureIgnoredTarget(select)).toBe(true);
    expect(isLauncherGestureIgnoredTarget(editorChild)).toBe(true);
    expect(isLauncherGestureIgnoredTarget(disabledEditor)).toBe(false);
  });

  it("reserves an active terminal touch selection while allowing ordinary terminal swipes", () => {
    const terminal = document.createElement("div");
    const row = document.createElement("span");
    terminal.append(row);
    expect(isLauncherGestureIgnoredTarget(row)).toBe(false);
    terminal.dataset.terminalTouchSelecting = "true";
    expect(isLauncherGestureIgnoredTarget(row)).toBe(true);
    delete terminal.dataset.terminalTouchSelecting;
    expect(isLauncherGestureIgnoredTarget(row)).toBe(false);
  });
});
