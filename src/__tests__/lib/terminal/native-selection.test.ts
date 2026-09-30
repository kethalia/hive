// @vitest-environment jsdom
import type { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import { getTerminalSelectionText } from "@/lib/terminal/actions";
import {
  hasNativeTerminalSelection,
  installNativeTerminalSelection,
} from "@/lib/terminal/native-selection";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function setup() {
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
    getSelection: () => (position ? "redrawn buffer text" : ""),
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

it("retains native text and buffer coordinates across row replacement, then clears on deselection", () => {
  const { term, element, dispose } = setup();
  const spans = element.querySelectorAll("span");
  const selection = window.getSelection()!;
  // Backward selection across emoji and wide-character cells.
  selection.setBaseAndExtent(spans[1].firstChild!, 1, spans[0].firstChild!, 1);
  document.dispatchEvent(new Event("selectionchange"));
  expect(term.select).toHaveBeenCalledWith(1, 7, 4);
  element.querySelector(".xterm-rows")!.innerHTML = "<div>updated output</div>";
  document.dispatchEvent(new Event("selectionchange"));
  expect(selection.isCollapsed).toBe(true);
  expect(getTerminalSelectionText(term)).toBe("😀界");
  const copy = new Event("copy", { bubbles: true, cancelable: true });
  const setData = vi.fn();
  Object.defineProperty(copy, "clipboardData", { value: { setData } });
  element.dispatchEvent(copy);
  expect(setData).toHaveBeenCalledWith("text/plain", "😀界");
  expect(copy.defaultPrevented).toBe(true);
  term.clearSelection();
  expect(getTerminalSelectionText(term)).toBe("");
  dispose();
});

it("tracks multi-row ranges and removes preserved text when disposed", () => {
  const { term, element, dispose } = setup();
  const rows = element.querySelector(".xterm-rows")!.children;
  window
    .getSelection()!
    .setBaseAndExtent(rows[0].firstChild!.firstChild!, 0, rows[1].firstChild!, 3);
  document.dispatchEvent(new Event("selectionchange"));
  expect(term.select).toHaveBeenCalledWith(0, 7, 13);
  window.getSelection()!.removeAllRanges();
  dispose();
  expect(getTerminalSelectionText(term)).toBe("redrawn buffer text");
});

it("does not shrink a captured multi-row selection when only one endpoint redraws", () => {
  const { term, element, dispose } = setup();
  const rows = element.querySelector(".xterm-rows")!.children;
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(rows[0].firstChild!.firstChild!, 1, rows[1].firstChild!, 3);
  document.dispatchEvent(new Event("selectionchange"));
  const original = getTerminalSelectionText(term);
  rows[0].replaceChildren(document.createTextNode("updated"));
  document.dispatchEvent(new Event("selectionchange"));
  expect(selection.isCollapsed).toBe(false);
  expect(term.select).toHaveBeenCalledTimes(1);
  expect(getTerminalSelectionText(term)).toBe(original);
  // A fresh user selection can replace the snapshot.
  element.dispatchEvent(new Event("pointerdown"));
  selection.setBaseAndExtent(rows[1].firstChild!, 0, rows[1].firstChild!, 3);
  document.dispatchEvent(new Event("selectionchange"));
  expect(getTerminalSelectionText(term)).toBe("sec");
  dispose();
});
