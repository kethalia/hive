// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { TerminalContextMenu } from "@/components/terminal/TerminalContextMenu";

describe("TerminalContextMenu", () => {
  const defaultProps = {
    position: { x: 100, y: 200 } as { x: number; y: number } | null,
    onClose: vi.fn(),
    hasSelection: false,
    onCopy: vi.fn(),
    onPaste: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when position is null", () => {
    render(<TerminalContextMenu {...defaultProps} position={null} />);
    expect(screen.queryByRole("menuitem", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("renders menu at specified coordinates when position provided", () => {
    render(<TerminalContextMenu {...defaultProps} />);
    const copyBtn = screen.getByRole("menuitem", { name: /copy/i });
    const menu = copyBtn.closest("div[class*='fixed']");
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveStyle({ left: "100px", top: "200px" });
  });

  it("Copy item has disabled attribute when hasSelection=false", () => {
    render(<TerminalContextMenu {...defaultProps} hasSelection={false} />);
    const copyBtn = screen.getByRole("menuitem", { name: /copy/i });
    expect(copyBtn).toBeDisabled();
  });

  it("Copy item enabled when hasSelection=true", () => {
    render(<TerminalContextMenu {...defaultProps} hasSelection={true} />);
    const copyBtn = screen.getByRole("menuitem", { name: /copy/i });
    expect(copyBtn).not.toBeDisabled();
  });

  it("clicking Copy calls onCopy callback and closes", () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        {...defaultProps}
        hasSelection={true}
        onCopy={onCopy}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /copy/i }));
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clicking Paste calls onPaste callback and closes", () => {
    const onPaste = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        {...defaultProps}
        onPaste={onPaste}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /paste/i }));
    expect(onPaste).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("New Session and Close Session items render when callbacks provided", () => {
    render(
      <TerminalContextMenu
        {...defaultProps}
        onNewSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );
    expect(screen.getByRole("menuitem", { name: /new session/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /close session/i })).toBeInTheDocument();
  });

  it("New Session and Close Session items hidden when callbacks not provided", () => {
    render(<TerminalContextMenu {...defaultProps} />);
    expect(screen.queryByRole("menuitem", { name: /new session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /close session/i })).not.toBeInTheDocument();
  });

  it("clicking New Session calls onNewSession and closes", () => {
    const onNewSession = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        {...defaultProps}
        onNewSession={onNewSession}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /new session/i }));
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clicking Close Session calls onCloseSession and closes", () => {
    const onCloseSession = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalContextMenu
        {...defaultProps}
        onCloseSession={onCloseSession}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /close session/i }));
    expect(onCloseSession).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("pressing Escape calls onClose", () => {
    const onClose = vi.fn();
    render(<TerminalContextMenu {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clicking outside menu calls onClose", () => {
    const onClose = vi.fn();
    render(<TerminalContextMenu {...defaultProps} onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("menu shows keyboard shortcut hints", () => {
    render(<TerminalContextMenu {...defaultProps} />);
    expect(screen.getByText("Ctrl+C")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+V")).toBeInTheDocument();
  });
});
