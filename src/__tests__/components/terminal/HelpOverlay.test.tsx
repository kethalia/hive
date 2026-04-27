// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockGetAll = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: () => ({
    register: mockRegister,
    unregister: mockUnregister,
    getAll: mockGetAll,
    handleKeyEvent: vi.fn(),
    activeTerminal: null,
    activeSend: null,
    setActiveTerminal: vi.fn(),
  }),
  useRegisterKeybinding: (entry: {
    id: string;
    keys: string[];
    action: () => boolean;
    description: string;
    category: string;
    enabledInBrowser: boolean;
  }) => {
    mockRegister(entry);
  },
}));

let mockPwaStandalone = false;
vi.mock("@/lib/terminal/pwa", () => ({
  usePwaStandalone: () => mockPwaStandalone,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (v: boolean) => void;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-testid="dialog-title">{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
  }) => (
    <span data-testid="badge" className={className}>
      {children}
    </span>
  ),
}));

vi.mock("lucide-react", () => ({
  XIcon: ({ className }: { className?: string }) => (
    <span data-testid="x-icon" className={className}>
      ×
    </span>
  ),
}));

import { HelpOverlay } from "@/components/terminal/HelpOverlay";

const testEntries = [
  {
    id: "clipboard:copy",
    keys: ["ctrl+c", "cmd+c"],
    action: () => false,
    description: "Copy selection",
    category: "clipboard",
    enabledInBrowser: true,
  },
  {
    id: "clipboard:paste",
    keys: ["ctrl+v", "cmd+v"],
    action: () => false,
    description: "Paste from clipboard",
    category: "clipboard",
    enabledInBrowser: true,
  },
  {
    id: "session:new",
    keys: ["ctrl+t"],
    action: () => false,
    description: "New session",
    category: "session",
    enabledInBrowser: false,
  },
  {
    id: "help:show",
    keys: ["shift+?"],
    action: () => false,
    description: "Show keyboard shortcuts",
    category: "general",
    enabledInBrowser: true,
  },
];

function renderOpenOverlay() {
  mockGetAll.mockReturnValue(testEntries);
  const { container } = render(<HelpOverlay />);
  const registered = mockRegister.mock.calls[0]?.[0];
  if (registered?.action) {
    act(() => {
      registered.action();
    });
  }
  return { container, registered };
}

describe("HelpOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPwaStandalone = false;
    mockGetAll.mockReturnValue(testEntries);
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when overlay is closed", () => {
    const { container } = render(<HelpOverlay />);
    expect(container.querySelector("[data-testid='dialog']")).toBeNull();
  });

  it("renders all shortcuts when open, grouped by category", () => {
    renderOpenOverlay();
    expect(screen.getByTestId("dialog")).toBeInTheDocument();
    expect(screen.getByText("Copy selection")).toBeInTheDocument();
    expect(screen.getByText("Paste from clipboard")).toBeInTheDocument();
    expect(screen.getByText("New session")).toBeInTheDocument();
    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
  });

  it("shows category headers", () => {
    renderOpenOverlay();
    expect(screen.getByText("general")).toBeInTheDocument();
    expect(screen.getByText("clipboard")).toBeInTheDocument();
    expect(screen.getByText("session")).toBeInTheDocument();
  });

  it("formats key combos for display", () => {
    renderOpenOverlay();
    expect(screen.getByText("⇧ + ?")).toBeInTheDocument();
  });

  it("shows PWA only badge on enabledInBrowser:false shortcuts in browser mode", () => {
    mockPwaStandalone = false;
    renderOpenOverlay();
    const badges = screen.getAllByTestId("badge");
    expect(badges.length).toBeGreaterThanOrEqual(1);
    expect(badges.some((b) => b.textContent === "PWA only")).toBe(true);
  });

  it("hides PWA badges when running as standalone PWA", () => {
    mockPwaStandalone = true;
    renderOpenOverlay();
    expect(screen.queryByTestId("badge")).toBeNull();
  });

  it("shows install nudge in browser mode", () => {
    mockPwaStandalone = false;
    renderOpenOverlay();
    expect(
      screen.getByText("Install as app for more shortcuts"),
    ).toBeInTheDocument();
  });

  it("hides install nudge in PWA mode", () => {
    mockPwaStandalone = true;
    renderOpenOverlay();
    expect(
      screen.queryByText("Install as app for more shortcuts"),
    ).not.toBeInTheDocument();
  });

  it("hides install nudge after dismissal", () => {
    mockPwaStandalone = false;
    renderOpenOverlay();
    const dismissBtn = screen.getByRole("button", { name: /dismiss/i });
    fireEvent.click(dismissBtn);
    expect(
      screen.queryByText("Install as app for more shortcuts"),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem("hive:help-nudge-dismissed")).toBe("true");
  });

  it("the help:show keybinding is registered and appears in the list", () => {
    renderOpenOverlay();
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "help:show",
        keys: ["shift+?"],
      }),
    );
    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
  });

  it("toggles open state via registered action", () => {
    mockGetAll.mockReturnValue(testEntries);
    render(<HelpOverlay />);

    expect(screen.queryByTestId("dialog")).toBeNull();

    const registered = mockRegister.mock.calls[0]?.[0];
    act(() => {
      registered.action();
    });
    expect(screen.getByTestId("dialog")).toBeInTheDocument();

    act(() => {
      registered.action();
    });
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("general category appears first in the list", () => {
    renderOpenOverlay();
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings[0]).toBe("general");
  });
});
