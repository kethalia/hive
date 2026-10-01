// @vitest-environment jsdom
import type { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import { copyTerminalSelection, getTerminalSelectionText } from "@/lib/terminal/actions";
import {
  hasNativeTerminalSelection,
  installNativeTerminalSelection,
} from "@/lib/terminal/native-selection";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function setup(wrapped = false) {
  const host = document.createElement("div");
  host.dataset.terminalNativeSelection = "true";
  host.innerHTML =
    '<div class="xterm"><div class="xterm-rows"><div><span>A😀</span><span>界B</span></div><div>second</div></div></div>';
  document.body.append(host);
  const element = host.firstElementChild as HTMLElement;
  let position: object | undefined;
  let changed = () => {};
  const cells = [
    { chars: "A", width: 1 },
    { chars: "😀", width: 2 },
    { chars: "", width: 0 },
    { chars: "界", width: 2 },
    { chars: "", width: 0 },
    { chars: "B", width: 1 },
  ];
  const term = {
    element,
    cols: 10,
    buffer: {
      active: {
        viewportY: 7,
        getLine: (y: number) => ({
          isWrapped: y === 8 && wrapped,
          translateToString: (_trim: boolean, start = 0, end = 10) =>
            (y === 7 ? cells : Array.from("second", (chars) => ({ chars, width: 1 })))
              .slice(start, end)
              .map((cell) => cell.chars)
              .join(""),
          getCell: (x: number) => {
            const cell = y === 7 ? cells[x] : { chars: "second"[x], width: 1 };
            return { getChars: () => cell?.chars ?? "", getWidth: () => cell?.width ?? 1 };
          },
        }),
      },
    },
    select: vi.fn((x: number, y: number, length: number) => {
      position = { x, y, length };
      changed();
    }),
    getSelectionPosition: () => position,
    getSelection: vi.fn((): string => (position ? "redrawn buffer text" : "")),
    clearSelection: () => {
      position = undefined;
      changed();
    },
    onSelectionChange: (handler: () => void) => {
      changed = handler;
      return { dispose: vi.fn() };
    },
  };
  const dispose = installNativeTerminalSelection(term as unknown as Terminal);
  return { term, element, dispose };
}

it("scopes selections to the terminal containing both endpoints", () => {
  const { element, dispose } = setup();
  const sibling = document.createElement("div");
  sibling.textContent = "another pane";
  document.body.append(sibling);
  const selection = window.getSelection()!;
  selection.selectAllChildren(sibling);
  expect(hasNativeTerminalSelection(element)).toBe(false);
  selection.selectAllChildren(element.querySelector("span")!);
  expect(hasNativeTerminalSelection(element)).toBe(true);
  selection.setBaseAndExtent(element.querySelector("span")!.firstChild!, 0, sibling.firstChild!, 3);
  expect(hasNativeTerminalSelection(element)).toBe(false);
  dispose();
});

it("keeps native endpoints intact while capturing and extending selection", () => {
  const { term, element, dispose } = setup();
  const spans = element.querySelectorAll("span");
  const selection = window.getSelection()!;
  const anchor = spans[0].firstChild!;
  selection.setBaseAndExtent(anchor, 1, spans[1].firstChild!, 1);
  document.dispatchEvent(new Event("selectionchange"));
  expect(term.select).not.toHaveBeenCalled();
  expect(selection.anchorNode).toBe(anchor);
  expect(getTerminalSelectionText(term)).toBe("😀界");
  element.dispatchEvent(new Event("touchstart"));
  selection.setBaseAndExtent(anchor, 0, spans[1].firstChild!, 2);
  document.dispatchEvent(new Event("selectionchange"));
  expect(getTerminalSelectionText(term)).toBe("A😀界B");
  expect(selection.anchorNode).toBe(anchor);
  expect(term.select).not.toHaveBeenCalled();
  const copy = new Event("copy", { bubbles: true, cancelable: true });
  const setData = vi.fn();
  Object.defineProperty(copy, "clipboardData", { value: { setData } });
  element.dispatchEvent(copy);
  expect(setData).toHaveBeenCalledWith("text/plain", "A😀界B");
  expect(selection.isCollapsed).toBe(false);
  dispose();
});

it.each([
  false,
  true,
])("reads multi-row canonical text without redrawing (wrapped=%s)", (wrapped) => {
  const { term, element, dispose } = setup(wrapped);
  const rows = element.querySelector(".xterm-rows")!.children;
  window
    .getSelection()!
    .setBaseAndExtent(rows[0].firstChild!.firstChild!, 0, rows[1].firstChild!, 3);
  document.dispatchEvent(new Event("selectionchange"));
  expect(getTerminalSelectionText(term)).toBe(wrapped ? "A😀界Bsec" : "A😀界B\nsec");
  expect(term.select).not.toHaveBeenCalled();
  dispose();
});

it("clears captured text when the user dismisses the native range", () => {
  const { term, element, dispose } = setup();
  window.getSelection()!.selectAllChildren(element.querySelector("span")!);
  document.dispatchEvent(new Event("selectionchange"));
  window.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  expect(getTerminalSelectionText(term)).toBe("");
  dispose();
});

it("retains a copy fallback after an unavoidable row replacement", () => {
  const { term, element, dispose } = setup();
  window.getSelection()!.selectAllChildren(element.querySelector("span")!);
  document.dispatchEvent(new Event("selectionchange"));
  element.querySelector(".xterm-rows")!.replaceChildren();
  document.dispatchEvent(new Event("selectionchange"));
  expect(getTerminalSelectionText(term)).toBe("A😀");
  element.dispatchEvent(new Event("touchstart"));
  expect(getTerminalSelectionText(term)).toBe("");
  dispose();
});

it.each([
  false,
  true,
])("clears copied snapshots even if rows redraw before copy completes (redraw=%s)", async (redraw) => {
  const { term, element, dispose } = setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    window.getSelection()!.selectAllChildren(element.querySelector("span")!);
    document.dispatchEvent(new Event("selectionchange"));
    copyTerminalSelection(term);
    if (redraw) {
      element.querySelector(".xterm-rows")!.replaceChildren();
      document.dispatchEvent(new Event("selectionchange"));
      expect(getTerminalSelectionText(term)).toBe("A😀");
    }
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("A😀");
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(getTerminalSelectionText(term)).toBe("");
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
    dispose();
  }
});

it.each([
  "pointerdown",
  "touchstart",
])("clears detached snapshots on an outside %s but preserves Copy actions", (type) => {
  const { term, element, dispose } = setup();
  window.getSelection()!.selectAllChildren(element.querySelector("span")!);
  document.dispatchEvent(new Event("selectionchange"));
  element.querySelector(".xterm-rows")!.replaceChildren();
  document.dispatchEvent(new Event("selectionchange"));
  const copy = document.createElement("button");
  const icon = document.createElement("span");
  copy.append(icon);
  document.body.append(copy);
  icon.dispatchEvent(new Event(type, { bubbles: true }));
  expect(getTerminalSelectionText(term)).toBe("A😀");
  const outside = document.createElement("div");
  document.body.append(outside);
  const changed = vi.fn();
  document.addEventListener("selectionchange", changed);
  try {
    outside.dispatchEvent(new Event(type, { bubbles: true }));
    expect(getTerminalSelectionText(term)).toBe("");
    expect(changed).toHaveBeenCalledOnce();
    dispose();
    outside.dispatchEvent(new Event(type, { bubbles: true }));
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    document.removeEventListener("selectionchange", changed);
    dispose();
  }
});

it("notifies Copy availability after copying an already detached snapshot", async () => {
  const { term, element, dispose } = setup();
  window.getSelection()!.selectAllChildren(element.querySelector("span")!);
  document.dispatchEvent(new Event("selectionchange"));
  element.querySelector(".xterm-rows")!.replaceChildren();
  document.dispatchEvent(new Event("selectionchange"));
  let available = true;
  const update = () => {
    available = Boolean(getTerminalSelectionText(term));
  };
  document.addEventListener("selectionchange", update);
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  try {
    copyTerminalSelection(term);
    await Promise.resolve();
    expect(available).toBe(false);
  } finally {
    document.removeEventListener("selectionchange", update);
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
    dispose();
  }
});
