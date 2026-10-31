// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneralWorkspaceDock } from "@/components/workspaces/GeneralWorkspaceDock";
import { KeybindingContext, type KeybindingContextValue } from "@/hooks/useKeybindings";
import { OPEN_GLOBAL_COMMAND_PALETTE_EVENT } from "@/lib/terminal/global-command-palette";
import { OPEN_KEYBINDING_HELP_EVENT } from "@/lib/terminal/help-overlay";
import { applyMobileModifiers, getMobileModifiers } from "@/lib/terminal/mobile-modifiers";
import { emptyGeneralWorkspace } from "@/lib/workspaces/general-workspace";

const effects = vi.hoisted(() => ({ copy: vi.fn(), paste: vi.fn(), upload: vi.fn() }));
vi.mock("@/lib/terminal/actions", () => ({
  copyTerminalSelection: effects.copy,
  pasteClipboardApiToTerminal: effects.paste,
  getTerminalSelectionText: (term: Terminal) => term.getSelection(),
}));
vi.mock("@/lib/terminal/clipboard", () => ({ handleTerminalPasteOutcome: effects.upload }));

function terminal() {
  let selection = "";
  let change = () => {};
  return {
    term: {
      getSelection: () => selection,
      onSelectionChange: (listener: () => void) => {
        change = listener;
        return {
          dispose: () => {
            change = () => {};
          },
        };
      },
    } as unknown as Terminal,
    select(text: string) {
      selection = text;
      change();
    },
  };
}
const board = emptyGeneralWorkspace();
const callbacks = { onSelect: vi.fn(), onCreate: vi.fn(), onRemove: vi.fn() };
function tree(term: Terminal | null, send = vi.fn(), active = true) {
  const value = { activeTerminal: term, activeSend: send } as unknown as KeybindingContextValue;
  return (
    <KeybindingContext value={value}>
      <textarea aria-label="Terminal input" className="xterm-helper-textarea" />
      <GeneralWorkspaceDock
        boards={board.boards}
        activeBoardKey={board.activeBoardKey}
        terminal={active ? { workspaceId: "software", sessionName: "shell" } : undefined}
        {...callbacks}
      />
    </KeybindingContext>
  );
}
function openKeys() {
  const opener = screen.getByRole("button", { name: "Extra keyboard" });
  fireEvent.pointerDown(opener, { button: 0 });
  fireEvent.click(opener);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("live workspace dock", () => {
  it("opens the existing app launcher and shortcut help", () => {
    const launch = vi.fn(),
      help = vi.fn();
    window.addEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, launch);
    window.addEventListener(OPEN_KEYBINDING_HELP_EVENT, help);
    try {
      render(tree(null));
      fireEvent.click(screen.getByRole("button", { name: "Apps" }));
      fireEvent.click(screen.getByRole("button", { name: "Keybinds" }));
      expect(launch).toHaveBeenCalledOnce();
      expect(help).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, launch);
      window.removeEventListener(OPEN_KEYBINDING_HELP_EVENT, help);
    }
  });

  it("preserves terminal focus and shares one-shot modifiers with native input", () => {
    const { term } = terminal(),
      send = vi.fn();
    render(tree(term, send));
    const input = screen.getByRole("textbox");
    input.focus();
    openKeys();
    expect(input).toHaveFocus();
    const ctrl = screen.getByRole("button", { name: "Ctrl modifier" });
    fireEvent.pointerDown(ctrl, { button: 0 });
    fireEvent.click(ctrl);
    expect(input).toHaveFocus();
    expect(ctrl).toHaveAttribute("aria-pressed", "true");
    let encoded = "";
    act(() => {
      encoded = applyMobileModifiers(term, "c");
    });
    expect(encoded).toBe("\x03");
    expect(ctrl).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(ctrl);
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Up" }));
    expect(send).toHaveBeenCalledWith("\x1b[1;5A");
    expect(ctrl).toHaveAttribute("aria-pressed", "false");
    expect(input).toHaveFocus();
  });

  it("keeps terminal focus through touch expansion/minimisation after auto-hide", () => {
    vi.useFakeTimers();
    const { term } = terminal();
    render(tree(term));
    const input = screen.getByRole("textbox");
    input.focus();
    act(() => vi.advanceTimersByTime(2500));
    const tap = (button: HTMLElement) => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperties(event, {
          pointerType: { value: "touch" },
          pointerId: { value: 1 },
          isPrimary: { value: true },
        });
        fireEvent(button, event);
      }
      act(() => vi.advanceTimersToNextFrame());
    };
    tap(screen.getByRole("button", { name: "Expand dock" }));
    expect(input).toHaveFocus();
    openKeys();
    fireEvent.click(screen.getByRole("button", { name: "Ctrl modifier" }));
    tap(screen.getByRole("button", { name: "Minimise dock" }));
    expect(input).toHaveFocus();
    tap(screen.getByRole("button", { name: "Expand dock" }));
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "Ctrl modifier" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    act(() => {
      applyMobileModifiers(term, "c");
    });
    expect(screen.getByRole("button", { name: "Ctrl modifier" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const minimise = screen.getByRole("button", { name: "Minimise dock" });
    minimise.focus();
    fireEvent.click(minimise);
    const expand = screen.getByRole("button", { name: "Expand dock" });
    expect(expand).toHaveFocus();
    fireEvent.click(expand);
    act(() => vi.advanceTimersToNextFrame());
    expect(screen.getByRole("button", { name: "Minimise dock" })).toHaveFocus();
  });

  it("clears modifiers on terminal changes and prevents sends to an inactive terminal", () => {
    const a = terminal(),
      b = terminal(),
      send = vi.fn();
    const view = render(tree(a.term, send));
    openKeys();
    fireEvent.click(screen.getByRole("button", { name: "Alt modifier" }));
    expect(getMobileModifiers(a.term).alt).toBe(true);
    view.rerender(tree(b.term, send));
    expect(getMobileModifiers(a.term).alt).toBe(false);
    expect(screen.getByRole("button", { name: "Alt modifier" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    view.rerender(tree(b.term, send, false));
    expect(screen.getByRole("button", { name: "Enter" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("uses native selection/clipboard/upload handlers and session-scoped font settings", async () => {
    const target = terminal(),
      send = vi.fn();
    render(tree(target.term, send));
    openKeys();
    expect(screen.getByRole("button", { name: "Copy terminal selection" })).toBeDisabled();
    act(() => target.select("selected output"));
    fireEvent.click(screen.getByRole("button", { name: "Copy terminal selection" }));
    expect(effects.copy).toHaveBeenCalledWith(
      target.term,
      expect.objectContaining({ onStatus: expect.any(Function) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    expect(effects.paste).toHaveBeenCalledWith(
      target.term,
      send,
      expect.objectContaining({ workspaceId: "software" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));
    expect(localStorage.getItem('terminal:font-size:["software","shell"]')).toBe("14");
    const files = [new File(["body"], "example.txt")];
    fireEvent.click(screen.getByRole("button", { name: "Upload files" }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files } });
    });
    expect(effects.upload).toHaveBeenCalledWith(
      { kind: "asset-files", files },
      expect.objectContaining({ term: target.term, send, workspaceId: "software" }),
    );
  });
});
