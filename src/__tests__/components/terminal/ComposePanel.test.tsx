// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockActiveSend } = vi.hoisted(() => ({ mockActiveSend: vi.fn() }));

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: () => ({
    activeSend: mockActiveSend,
  }),
}));

import { ComposePanel } from "@/components/terminal/ComposePanel";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mockActiveSend.mockClear();
});

describe("ComposePanel", () => {
  it("uses a footer button group with Cancel and Send instead of close or floating send buttons", () => {
    render(<ComposePanel onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Close compose panel" })).not.toBeInTheDocument();

    const actions = screen.getByRole("group", { name: "Compose actions" });
    expect(actions).toHaveClass("w-full", "rounded-none");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("flex-1", "min-h-11");
    expect(screen.getByRole("button", { name: "Send command" })).toHaveClass("flex-1", "min-h-11");
  });

  it("cancels without sending", () => {
    const onClose = vi.fn();
    render(<ComposePanel onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockActiveSend).not.toHaveBeenCalled();
  });

  it("sends the draft and closes from the footer button", () => {
    const onClose = vi.fn();
    render(<ComposePanel onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("Type multi-line command..."), {
      target: { value: "pnpm test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send command" }));

    expect(mockActiveSend).toHaveBeenNthCalledWith(1, "pnpm test");
    expect(mockActiveSend).toHaveBeenNthCalledWith(2, "\r");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses initial draft and explicit send target", () => {
    const onClose = vi.fn();
    const onSend = vi.fn();
    render(
      <ComposePanel
        initialDraft="/tmp/hive-terminal-paste/image.png"
        targetLabel="pane-1"
        onSend={onSend}
        onClose={onClose}
      />,
    );

    expect(screen.getByText(/Compose to pane-1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send command" }));

    expect(onSend).toHaveBeenCalledWith("/tmp/hive-terminal-paste/image.png");
    expect(mockActiveSend).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sends with Ctrl+Enter", () => {
    const onClose = vi.fn();
    render(<ComposePanel onClose={onClose} />);
    const textarea = screen.getByPlaceholderText("Type multi-line command...");

    fireEvent.change(textarea, { target: { value: "echo hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(mockActiveSend).toHaveBeenNthCalledWith(1, "echo hello");
    expect(mockActiveSend).toHaveBeenNthCalledWith(2, "\r");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes with Cmd+` while focus is inside the textarea", () => {
    const onClose = vi.fn();
    render(<ComposePanel onClose={onClose} />);
    const textarea = screen.getByPlaceholderText("Type multi-line command...");

    fireEvent.keyDown(textarea, { key: "`", metaKey: true });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockActiveSend).not.toHaveBeenCalled();
  });

  it("hides the header while keeping footer actions in compose sheet mode", () => {
    render(<ComposePanel hideHeader onClose={vi.fn()} />);

    expect(screen.queryByText(/Compose — .*Enter to send/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type multi-line command...")).toHaveAttribute(
      "data-mobile-scroll-allow",
      "true",
    );
    expect(screen.getByRole("group", { name: "Compose actions" })).toBeInTheDocument();
  });
});
