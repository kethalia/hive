// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  expect(screen.getByRole("button", { name: "Upload files" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Decrease font size" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));
  expect(increase).toHaveBeenCalledTimes(1);
});

it("opens the native file picker and accepts PDFs and multiple files without clipboard access", async () => {
  const upload = vi.fn().mockResolvedValue(undefined);
  const haptic = vi.fn();
  render(<MobileTerminalControls onUploadFiles={upload} onHapticFeedback={haptic} />);
  const input = screen.getByLabelText("Choose files to upload") as HTMLInputElement;
  const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});

  fireEvent.click(screen.getByRole("button", { name: "Upload files" }));
  expect(openPicker).toHaveBeenCalledOnce();
  expect(haptic).toHaveBeenCalledOnce();
  expect(input).toHaveAttribute("type", "file");
  expect(input).toHaveAttribute("multiple");
  expect(input).not.toHaveAttribute("accept");

  const pdf = new File(["%PDF-1.7"], "document.pdf", { type: "application/pdf" });
  const text = new File(["notes"], "notes.txt", { type: "text/plain" });
  fireEvent.change(input, { target: { files: [pdf, text] } });
  expect(upload).toHaveBeenCalledExactlyOnceWith([pdf, text]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Upload files" })).toBeEnabled());
  expect(input.value).toBe("");

  fireEvent.change(input, { target: { files: [pdf] } });
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Upload files" })).toBeEnabled());
  expect(upload).toHaveBeenLastCalledWith([pdf]);
  expect(send).not.toHaveBeenCalled();
});

it("ignores picker cancellation and disables additional uploads while one is pending", async () => {
  let finishUpload: (() => void) | undefined;
  const upload = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishUpload = resolve;
      }),
  );
  render(<MobileTerminalControls onUploadFiles={upload} />);
  const input = screen.getByLabelText("Choose files to upload");
  const button = screen.getByRole("button", { name: "Upload files" });
  fireEvent.change(input, { target: { files: [] } });
  expect(upload).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { files: [new File(["pdf"], "document.pdf")] } });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button.querySelector(".animate-spin")).not.toBeNull();
  expect(input).toBeDisabled();
  fireEvent.click(button);
  expect(upload).toHaveBeenCalledOnce();
  await act(async () => finishUpload?.());
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute("aria-busy");
});

it.each([
  "copy",
  "paste",
] as const)("shows a spinner for pending %s and blocks duplicate clipboard actions", (action) => {
  const copy = vi.fn();
  const paste = vi.fn();
  const { rerender } = render(
    <MobileTerminalControls
      hasSelection
      onCopy={copy}
      onPaste={paste}
      onUploadFiles={vi.fn()}
      clipboardBusyAction={action}
      clipboardStatusText="Working..."
      showClipboardStatus
    />,
  );
  const busy = screen.getByRole("button", {
    name: action === "copy" ? "Copy terminal selection" : "Paste from clipboard",
  });
  expect(busy).toHaveAttribute("aria-busy", "true");
  expect(busy.querySelector(".animate-spin")).not.toBeNull();
  for (const label of ["Copy terminal selection", "Paste from clipboard", "Upload files"]) {
    const button = screen.getByRole("button", { name: label });
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(copy).not.toHaveBeenCalled();
  expect(paste).not.toHaveBeenCalled();

  rerender(
    <MobileTerminalControls
      hasSelection
      onCopy={copy}
      onPaste={paste}
      clipboardStatusText="Paste complete"
      showClipboardStatus
    />,
  );
  expect(busy).toBeEnabled();
  expect(busy).not.toHaveAttribute("aria-busy");
  expect(screen.getByText("Paste complete")).not.toHaveClass("sr-only");
});

it("disables file selection when the terminal target is unavailable", () => {
  render(
    <MobileTerminalControls onUploadFiles={vi.fn()} uploadDisabledReason="Terminal is not ready" />,
  );
  expect(screen.getByRole("button", { name: "Upload files" })).toBeDisabled();
  expect(screen.getByLabelText("Choose files to upload")).toBeDisabled();
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

it("shows clipboard failure feedback without adding another row of buttons", () => {
  render(
    <MobileTerminalControls
      clipboardStatusText="Clipboard permission was denied."
      showClipboardStatus
    />,
  );
  const status = screen.getByText("Clipboard permission was denied.");
  expect(status).not.toHaveClass("sr-only");
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(screen.getAllByRole("group", { name: "Terminal keys" })).toHaveLength(1);
});

it("reserves saved selection only for the Copy control", () => {
  render(<MobileTerminalControls hasSelection onCopy={vi.fn()} onPaste={vi.fn()} />);
  const copy = screen.getByRole("button", { name: "Copy terminal selection" });
  expect(copy).toHaveAttribute("data-terminal-selection-copy", "true");
  for (const button of screen.getAllByRole("button")) {
    if (button !== copy) expect(button).not.toHaveAttribute("data-terminal-selection-copy");
  }
});
