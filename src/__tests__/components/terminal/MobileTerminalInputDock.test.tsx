// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTerminalInputDock } from "@/components/terminal/MobileTerminalInputDock";
import type { KeybindingContextValue } from "@/hooks/useKeybindings";
import { KeybindingContext } from "@/hooks/useKeybindings";

function renderDock(activeSend: ((data: string) => void) | null = vi.fn()) {
  const context: KeybindingContextValue = {
    register: vi.fn(),
    unregister: vi.fn(),
    getAll: vi.fn(() => []),
    handleKeyEvent: vi.fn(() => true),
    activeTerminal: null,
    activeSend,
    setActiveTerminal: vi.fn(),
  };

  render(
    <KeybindingContext.Provider value={context}>
      <MobileTerminalInputDock />
    </KeybindingContext.Provider>,
  );

  return { activeSend };
}

afterEach(() => {
  cleanup();
});

describe("MobileTerminalInputDock", () => {
  it("renders a visible mobile-safe command input", () => {
    renderDock();

    expect(screen.getByTestId("mobile-terminal-input-dock")).toBeInTheDocument();
    const input = screen.getByLabelText("Type terminal command");
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("enterkeyhint", "send");
    expect(input).toHaveAttribute("autocapitalize", "off");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
  });

  it("sends the typed command plus enter and clears the draft", () => {
    const activeSend = vi.fn();
    renderDock(activeSend);

    const input = screen.getByLabelText("Type terminal command");
    fireEvent.change(input, { target: { value: "ls -la" } });
    fireEvent.click(screen.getByRole("button", { name: "Send command" }));

    expect(activeSend).toHaveBeenNthCalledWith(1, "ls -la");
    expect(activeSend).toHaveBeenNthCalledWith(2, "\r");
    expect(input).toHaveValue("");
  });

  it("keeps the visible input focused when action buttons are pressed", () => {
    renderDock();

    const input = screen.getByLabelText("Type terminal command");
    fireEvent.change(input, { target: { value: "pwd" } });
    const sendButton = screen.getByRole("button", { name: "Send command" });
    const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true });
    fireEvent(sendButton, pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);

    const mouseDown = new Event("mousedown", { bubbles: true, cancelable: true });
    fireEvent(sendButton, mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
  });

  it("disables send actions when no terminal sender is active", () => {
    renderDock(null);

    expect(screen.getByRole("button", { name: "Send command" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send Enter" })).toBeDisabled();
  });
});
