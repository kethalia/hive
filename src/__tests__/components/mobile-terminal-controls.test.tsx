// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileTerminalControls } from "@/components/terminal/MobileTerminalControls";
import { MOBILE_SMART_KEYS } from "@/lib/terminal/mobile-smart-keys";

const { send, useKeybindings, increase, decrease } = vi.hoisted(() => ({
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
  useKeybindings.mockReturnValue({ activeSend: send });
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
  fireEvent.click(screen.getByRole("button", { name: "Ctrl+G" }));
  expect(send).toHaveBeenLastCalledWith("\x07");
  expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "Shift" }));
  fireEvent.click(screen.getByRole("button", { name: "Shift+Enter" }));
  expect(send).toHaveBeenLastCalledWith("\x1b[13;2u");
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
  fireEvent.click(screen.getByRole("button", { name: "Ctrl+C" }));
  expect(send).toHaveBeenLastCalledWith("\x03");
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
