// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", () => ({
  Terminal: () => <span data-testid="icon-terminal">⊞</span>,
  Plus: () => <span data-testid="icon-plus">+</span>,
  SearchIcon: () => <span data-testid="icon-search">🔍</span>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogTrigger: () => null,
  DialogClose: () => null,
  DialogPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogOverlay: () => null,
}));

let capturedOnSelect: Map<string, () => void> = new Map();

vi.mock("@/components/ui/command", () => {
  return {
    CommandDialog: ({ children, open, onOpenChange }: {
      children: React.ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) => open ? (
      <div data-testid="command-dialog" data-open={open}>
        <button data-testid="close-dialog" onClick={() => onOpenChange(false)}>Close</button>
        {children}
      </div>
    ) : null,
    CommandInput: ({ placeholder }: { placeholder?: string }) => (
      <input data-testid="command-input" placeholder={placeholder} />
    ),
    CommandList: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="command-list">{children}</div>
    ),
    CommandEmpty: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="command-empty">{children}</div>
    ),
    CommandGroup: ({ heading, children }: { heading?: string; children: React.ReactNode }) => (
      <div data-testid={`command-group-${heading?.toLowerCase()}`} data-heading={heading}>{children}</div>
    ),
    CommandItem: ({ children, value, onSelect }: {
      children: React.ReactNode;
      value?: string;
      onSelect?: () => void;
    }) => {
      if (value && onSelect) capturedOnSelect.set(value, onSelect);
      return (
        <div
          data-testid={`command-item-${value ?? "action"}`}
          data-value={value}
          role="option"
          onClick={onSelect}
        >
          {children}
        </div>
      );
    },
    CommandShortcut: ({ children }: { children: React.ReactNode }) => (
      <span data-testid="command-shortcut">{children}</span>
    ),
  };
});

import { CommandPalette } from "@/components/terminal/CommandPalette";

const mockTabs = [
  { id: "tab-1", sessionName: "hive-main" },
  { id: "tab-2", sessionName: "dev-server" },
  { id: "tab-3", sessionName: "test-runner" },
];

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSelect = new Map();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <CommandPalette
        open={false}
        onOpenChange={vi.fn()}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-testid='command-dialog']")).toBeNull();
  });

  it("renders session list when open", () => {
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    expect(screen.getByTestId("command-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("command-item-hive-main")).toBeInTheDocument();
    expect(screen.getByTestId("command-item-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("command-item-test-runner")).toBeInTheDocument();
  });

  it("renders search input with placeholder", () => {
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    const input = screen.getByTestId("command-input");
    expect(input).toHaveAttribute("placeholder", "Search sessions…");
  });

  it("calls onSelectTab with correct tabId on item selection", () => {
    const onSelectTab = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={onSelectTab}
      />,
    );

    fireEvent.click(screen.getByTestId("command-item-dev-server"));

    expect(onSelectTab).toHaveBeenCalledWith("tab-2");
  });

  it("closes dialog after selecting a session", () => {
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("command-item-hive-main"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows 'New Session' command item with shortcut", () => {
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
        onCreateSession={vi.fn()}
      />,
    );

    expect(screen.getByText("New Session")).toBeInTheDocument();
    expect(screen.getByTestId("command-shortcut")).toHaveTextContent("Ctrl+T");
  });

  it("calls onCreateSession and closes when 'New Session' is selected", () => {
    const onCreateSession = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
        onCreateSession={onCreateSession}
      />,
    );

    const newSessionItem = screen.getByText("New Session").closest("[role='option']")!;
    fireEvent.click(newSessionItem);

    expect(onCreateSession).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not render 'New Session' when onCreateSession is not provided", () => {
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    expect(screen.queryByText("New Session")).not.toBeInTheDocument();
  });

  it("displays session names with correct text", () => {
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    expect(screen.getByText("hive-main")).toBeInTheDocument();
    expect(screen.getByText("dev-server")).toBeInTheDocument();
    expect(screen.getByText("test-runner")).toBeInTheDocument();
  });

  it("renders Sessions group heading", () => {
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    expect(screen.getByTestId("command-group-sessions")).toBeInTheDocument();
  });
});
