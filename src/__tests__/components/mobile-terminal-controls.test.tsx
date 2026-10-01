// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileTerminalControls } from "@/components/terminal/MobileTerminalControls";
import { applyMobileModifiers, getMobileModifiers } from "@/lib/terminal/mobile-modifiers";
import { MOBILE_SMART_KEYS } from "@/lib/terminal/mobile-smart-keys";

const { send, useKeybindings, increase, decrease, terminal } = vi.hoisted(() => ({
  terminal: {},
  send: vi.fn(),
  useKeybindings: vi.fn(),
  increase: vi.fn(),
  decrease: vi.fn(),
}));
vi.mock("@/hooks/useKeybindings", () => ({ useKeybindings }));
vi.mock("@/hooks/useTerminalFontStep", () => ({
  useTerminalFontStep: () => ({
    increase,
    decrease,
    canIncrease: true,
    canDecrease: false,
  }),
}));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useKeybindings.mockReturnValue({ activeSend: send, activeTerminal: terminal });
});

it("renders one native horizontally scrolling row without pages or selection mode", () => {
  render(<MobileTerminalControls />);
  const row = screen.getByRole("group", { name: "Terminal keys" });
  expect(row).toHaveClass("flex-nowrap", "overflow-x-auto");
  expect(row).toHaveAttribute("data-mobile-scroll-allow", "true");
  expect(screen.queryByLabelText("Terminal control pages")).toBeNull();
  expect(screen.queryByText("Select")).toBeNull();
  expect(screen.queryByText("Queue")).toBeNull();
  const buttons = within(row).getAllByRole("button");
  expect(buttons.every((button) => button.parentElement === row)).toBe(true);
  const labels = buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent);
  expect(new Set(labels).size).toBe(labels.length);
});

it("sends each unique quick key once with exact byte sequences", () => {
  const haptic = vi.fn();
  render(<MobileTerminalControls onHapticFeedback={haptic} />);
  for (const { label, sequence } of MOBILE_SMART_KEYS) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(send).toHaveBeenLastCalledWith(sequence);
  }
  expect(send).toHaveBeenCalledTimes(MOBILE_SMART_KEYS.length);
  expect(haptic).toHaveBeenCalledTimes(MOBILE_SMART_KEYS.length);
});

it("labels modified keys with the exact combination and resets after sending", () => {
  render(<MobileTerminalControls />);
  fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
  expect(screen.getByRole("button", { name: "Ctrl" })).toHaveClass("ring-2", "bg-primary");
  act(() => {
    expect(applyMobileModifiers(terminal, "g")).toBe("\x07");
  });
  expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "Shift" }));
  fireEvent.click(screen.getByRole("button", { name: "Shift+Enter" }));
  expect(send).toHaveBeenLastCalledWith("\x1b[13;2u");
  fireEvent.click(screen.getByRole("button", { name: "Shift" }));
  fireEvent.click(screen.getByRole("button", { name: "Shift+Tab" }));
  expect(send).toHaveBeenLastCalledWith("\x1b[Z");
});

it("preserves input focus without cancelling touch or horizontal pan", () => {
  render(<MobileTerminalControls />);
  const enter = screen.getByRole("button", { name: "Enter" });
  expect(fireEvent.pointerDown(enter, { pointerType: "touch" })).toBe(true);
  expect(fireEvent.touchStart(enter)).toBe(true);
  expect(fireEvent.mouseDown(enter)).toBe(false);
  expect(send).not.toHaveBeenCalled();
});

it("keeps clipboard actions distinct from terminal Ctrl+C and Ctrl+V", () => {
  const copy = vi.fn();
  const paste = vi.fn();
  render(<MobileTerminalControls hasSelection onCopy={copy} onPaste={paste} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy terminal selection" }));
  fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
  expect(copy).toHaveBeenCalledTimes(1);
  expect(paste).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
  act(() => {
    expect(applyMobileModifiers(terminal, "c")).toBe("\x03");
  });
  expect(copy).toHaveBeenCalledTimes(1);
});

it("disables unavailable actions and respects font limits", () => {
  useKeybindings.mockReturnValue({ activeSend: null });
  render(<MobileTerminalControls />);
  expect(screen.getByRole("button", { name: "Enter" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Copy terminal selection" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Paste from clipboard" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Decrease font size" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));
  expect(increase).toHaveBeenCalledTimes(1);
});

it("keeps ordinary keyboard keys out of the helper and renders direction symbols", () => {
  render(<MobileTerminalControls />);
  for (const label of [
    "a",
    "g",
    "1",
    "!",
    "/",
    "F1",
    "Shift+Tab",
    "Ctrl+C",
    "Ctrl+D",
    "Ctrl+L",
    "Ctrl+R",
    "Ctrl+T",
    "Ctrl+O",
  ]) {
    expect(screen.queryByRole("button", { name: label })).toBeNull();
  }
  for (const [name, symbol] of [
    ["Up", "↑"],
    ["Down", "↓"],
    ["Left", "←"],
    ["Right", "→"],
  ]) {
    expect(screen.getByRole("button", { name })).toHaveTextContent(symbol);
    expect(screen.getByRole("button", { name })).not.toHaveTextContent(name);
  }
});

it("clears pending modifiers when switching terminal or unmounting controls", () => {
  const { rerender, unmount } = render(<MobileTerminalControls />);
  fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
  const other = {};
  useKeybindings.mockReturnValue({ activeSend: send, activeTerminal: other });
  rerender(<MobileTerminalControls />);
  expect(getMobileModifiers(terminal).ctrl).toBe(false);
  expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "Alt" }));
  unmount();
  expect(getMobileModifiers(other).alt).toBe(false);
});
