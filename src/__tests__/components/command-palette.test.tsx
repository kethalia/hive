// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { cloneElement, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mobileState = vi.hoisted(() => ({ isMobile: false }));
const dragState = vi.hoisted(() => ({
  bindCallCount: 0,
  config: undefined as unknown,
  handler: undefined as ((state: Record<string, unknown>) => void) | undefined,
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobileState.isMobile,
}));

vi.mock("@use-gesture/react", () => ({
  useDrag: vi.fn((handler, config) => {
    dragState.handler = handler;
    dragState.config = config;

    return () => {
      dragState.bindCallCount += 1;
      return { "data-use-drag-bound": "true" };
    };
  }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", () => ({
  Terminal: () => <span data-testid="icon-terminal">⊞</span>,
  ChevronRight: () => <span data-testid="icon-chevron-right">›</span>,
  Plus: () => <span data-testid="icon-plus">+</span>,
  Search: () => <span data-testid="icon-search-action">🔎</span>,
  SearchIcon: () => <span data-testid="icon-search">🔍</span>,
  Triangle: () => <span data-testid="icon-triangle">▲</span>,
  X: () => <span data-testid="icon-close">×</span>,
}));

vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({
    children,
    side,
    mobileOnly: _mobileOnly,
    ...props
  }: ComponentProps<"aside"> & { side?: string; mobileOnly?: boolean }) => (
    <aside {...props} data-side={side}>
      {children}
    </aside>
  ),
  SidebarContent: ({ children, ...props }: ComponentProps<"div">) => (
    <div data-testid="sidebar-content" {...props}>
      {children}
    </div>
  ),
  SidebarGroup: ({ children, ...props }: ComponentProps<"div">) => (
    <div data-testid="sidebar-group" {...props}>
      {children}
    </div>
  ),
  SidebarGroupContent: ({ children, ...props }: ComponentProps<"div">) => (
    <div data-testid="sidebar-group-content" {...props}>
      {children}
    </div>
  ),
  SidebarHeader: ({ children, ...props }: ComponentProps<"div">) => (
    <div data-testid="sidebar-header" {...props}>
      {children}
    </div>
  ),
  SidebarGroupLabel: ({ children, ...props }: ComponentProps<"div">) => (
    <div data-testid="sidebar-group-label" {...props}>
      {children}
    </div>
  ),
  SidebarInput: (props: ComponentProps<"input">) => <input data-slot="sidebar-input" {...props} />,
  SidebarMenu: ({ children, ...props }: ComponentProps<"ul">) => (
    <ul data-testid="sidebar-menu" {...props}>
      {children}
    </ul>
  ),
  SidebarMenuItem: ({ children, ...props }: ComponentProps<"li">) => (
    <li data-testid="sidebar-menu-item" {...props}>
      {children}
    </li>
  ),
  SidebarMenuButton: ({
    children,
    render,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { render?: ReactNode; size?: string }) =>
    isValidElement<ComponentProps<"button">>(render) ? (
      cloneElement(render, props, children)
    ) : (
      <button type="button" {...props}>
        {children}
      </button>
    ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogTrigger: () => null,
  DialogClose: () => null,
  DialogPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogOverlay: () => null,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="sheet">{children}</div> : null,
  SheetContent: ({
    children,
    className,
    side,
    style,
    showCloseButton,
    ...props
  }: {
    children: ReactNode;
    className?: string;
    side?: string;
    style?: CSSProperties;
    showCloseButton?: boolean;
  } & Record<string, unknown>) => (
    <div
      {...props}
      data-testid="sheet-content"
      data-slot="sheet-content"
      data-side={side}
      data-show-close-button={String(showCloseButton)}
      className={className}
      style={style}
    >
      {children}
    </div>
  ),
  SheetTitle: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="sheet-title" data-slot="sheet-title" className={className}>
      {children}
    </div>
  ),
  SheetHeader: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="sheet-header" data-slot="sheet-header" className={className}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/command", () => {
  return {
    Command: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div data-testid="command" data-slot="command" className={className}>
        {children}
      </div>
    ),
    CommandDialog: ({
      children,
      contentClassName,
      open,
      onOpenChange,
    }: {
      children: ReactNode;
      contentClassName?: string;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) =>
      open ? (
        <div
          data-testid="command-dialog"
          data-open={open}
          data-content-class-name={contentClassName}
        >
          <button data-testid="close-dialog" onClick={() => onOpenChange(false)}>
            Close
          </button>
          {children}
        </div>
      ) : null,
    CommandInput: ({
      placeholder,
      className,
      value,
      onValueChange,
    }: {
      placeholder?: string;
      className?: string;
      value?: string;
      onValueChange?: (value: string) => void;
    }) => (
      <input
        data-testid="command-input"
        data-slot="command-input"
        placeholder={placeholder}
        className={className}
        value={value ?? ""}
        onChange={(event) => onValueChange?.(event.currentTarget.value)}
      />
    ),
    CommandList: ({ children, ...props }: ComponentProps<"div">) => (
      <div {...props} data-testid="command-list" data-slot="command-list">
        {children}
      </div>
    ),
    CommandEmpty: ({ children }: { children: ReactNode }) => (
      <div data-testid="command-empty">{children}</div>
    ),
    CommandGroup: ({ heading, children }: { heading?: string; children: ReactNode }) => (
      <div data-testid={`command-group-${heading?.toLowerCase()}`} data-heading={heading}>
        {children}
      </div>
    ),
    CommandItem: ({
      children,
      value,
      onSelect,
      className,
      tabIndex,
      "data-action-id": actionId,
    }: {
      children: ReactNode;
      value?: string;
      onSelect?: () => void;
      className?: string;
      tabIndex?: number;
      "data-action-id"?: string;
    }) => (
      <div
        cmdk-item=""
        data-action-id={actionId}
        data-testid={`command-item-${value ?? "action"}`}
        data-value={value}
        role="option"
        aria-selected={false}
        tabIndex={tabIndex}
        className={className}
        onClick={onSelect}
      >
        {children}
      </div>
    ),
    CommandShortcut: ({ children }: { children: ReactNode }) => (
      <span data-testid="command-shortcut">{children}</span>
    ),
  };
});

import { CommandPalette } from "@/components/terminal/CommandPalette";
import {
  DRAG_DISMISS_DISTANCE_PX,
  DRAG_DISMISS_VELOCITY,
  NO_TOUCH_STYLE,
} from "@/lib/gestures/conventions";

type Listener = () => void;

interface StubVisualViewport {
  height: number;
  listeners: Map<string, Set<Listener>>;
  addEventListener: (type: string, cb: Listener) => void;
  removeEventListener: (type: string, cb: Listener) => void;
  dispatch: (type: string) => void;
}

interface StubMediaQueryList extends MediaQueryList {
  dispatch: (matches?: boolean) => void;
}

function installVisualViewport(height: number): StubVisualViewport {
  const listeners = new Map<string, Set<Listener>>();
  const stub: StubVisualViewport = {
    height,
    listeners,
    addEventListener: (type, cb) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type, cb) => {
      listeners.get(type)?.delete(cb);
    },
    dispatch: (type) => {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  };

  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    writable: true,
    value: stub,
  });

  return stub;
}

function clearVisualViewport() {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

function installMatchMedia(matches: boolean): StubMediaQueryList {
  const listeners = new Set<Listener>();
  let currentMatches = matches;
  const stub = {
    get matches() {
      return currentMatches;
    },
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn((_type: string, cb: Listener) => listeners.add(cb)),
    removeEventListener: vi.fn((_type: string, cb: Listener) => listeners.delete(cb)),
    addListener: vi.fn((cb: Listener) => listeners.add(cb)),
    removeListener: vi.fn((cb: Listener) => listeners.delete(cb)),
    dispatch: (nextMatches = currentMatches) => {
      currentMatches = nextMatches;
      for (const cb of listeners) cb();
    },
    dispatchEvent: vi.fn(),
  } as unknown as StubMediaQueryList;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => stub),
  });

  return stub;
}

function clearMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

function getDragHandler() {
  expect(dragState.handler).toEqual(expect.any(Function));
  return dragState.handler!;
}

function invokeDrag(overrides: Record<string, unknown>) {
  const gestureState = {
    active: false,
    direction: [0, 1],
    event: { preventDefault: vi.fn() },
    movement: [0, 0],
    velocity: [0, 0],
    ...overrides,
  };

  act(() => {
    getDragHandler()(gestureState);
  });

  return gestureState;
}

const mockTabs = [
  { id: "tab-1", sessionName: "hive-main" },
  { id: "tab-2", sessionName: "dev-server" },
  { id: "tab-3", sessionName: "test-runner" },
];

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileState.isMobile = false;
    dragState.bindCallCount = 0;
    dragState.config = undefined;
    dragState.handler = undefined;
    clearMatchMedia();
    clearVisualViewport();
  });

  afterEach(() => {
    cleanup();
    clearMatchMedia();
    clearVisualViewport();
    vi.restoreAllMocks();
  });

  it("renders no dialog or sheet when closed on desktop", () => {
    const { container } = render(
      <CommandPalette open={false} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    expect(container.querySelector("[data-testid='command-dialog']")).toBeNull();
    expect(container.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });

  it("renders no dialog or sheet when closed on mobile", () => {
    mobileState.isMobile = true;

    const { container } = render(
      <CommandPalette open={false} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    expect(container.querySelector("[data-testid='command-dialog']")).toBeNull();
    expect(container.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });

  it("renders desktop command dialog and not sheet content by default", () => {
    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    expect(screen.getByTestId("command-dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("sheet-content")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Drag to dismiss command palette" })).toBeNull();
    expect(screen.getByTestId("command-item-hive-main")).toBeInTheDocument();
    expect(screen.getByTestId("command-item-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("command-item-test-runner")).toBeInTheDocument();
    expect(screen.getByTestId("command-dialog")).toHaveAttribute(
      "data-content-class-name",
      "max-w-2xl",
    );
  });

  it("hides the scrollbar and shows directional triangles only where more content exists", () => {
    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    const list = screen.getByTestId("command-list");
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });

    fireEvent.scroll(list);
    expect(list.className).toContain("[scrollbar-width:none]");
    expect(list.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(screen.getByTestId("command-scroll-hint-up")).toHaveAttribute("data-visible", "false");
    expect(screen.getByTestId("command-scroll-hint-down")).toHaveAttribute("data-visible", "true");

    list.scrollTop = 150;
    fireEvent.scroll(list);
    expect(screen.getByTestId("command-scroll-hint-up")).toHaveAttribute("data-visible", "true");
    expect(screen.getByTestId("command-scroll-hint-down")).toHaveAttribute("data-visible", "true");

    list.scrollTop = 300;
    fireEvent.scroll(list);
    expect(screen.getByTestId("command-scroll-hint-up")).toHaveAttribute("data-visible", "true");
    expect(screen.getByTestId("command-scroll-hint-down")).toHaveAttribute("data-visible", "false");
  });

  it("renders mobile sheet content and not command dialog", () => {
    mobileState.isMobile = true;

    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    expect(screen.getByTestId("sheet-content")).toBeInTheDocument();
    expect(screen.queryByTestId("command-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("sheet-title")).toHaveTextContent("Command palette");
    expect(screen.getByTestId("sheet-title")).toHaveClass("sr-only");
  });

  it("renders search input with placeholder", () => {
    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    const input = screen.getByTestId("command-input");
    expect(input).toHaveAttribute("placeholder", "Search sessions…");
  });

  it("uses a bottom mobile sheet with visualViewport maxHeight", async () => {
    mobileState.isMobile = true;
    installVisualViewport(512);

    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    const sheet = screen.getByTestId("sheet-content");
    expect(sheet).toHaveAttribute("data-side", "bottom");
    expect(sheet).toHaveAttribute("data-show-close-button", "false");
    expect(sheet).toHaveAttribute("data-sidebar-gesture-ignore", "true");
    expect(sheet).toHaveClass("pb-safe");
    expect(sheet).toHaveClass("overflow-hidden");
    expect(sheet).toHaveClass("rounded-t-2xl");
    expect(sheet).toHaveClass("overscroll-contain");
    expect(sheet).toHaveClass("motion-reduce:transition-none");
    expect(sheet).toHaveClass("motion-reduce:duration-0");

    await waitFor(() => expect(sheet).toHaveStyle({ maxHeight: "512px" }));
  });

  it("renders the global mobile palette in the shared right sidebar shell", () => {
    mobileState.isMobile = true;

    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
        mobileSide="right"
      />,
    );

    const sidebar = screen.getByTestId("global-command-sidebar");
    expect(sidebar).toHaveAttribute("data-side", "right");
    expect(screen.queryByTestId("sheet-content")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-header")).toHaveTextContent("Navigate");
    expect(screen.getByTestId("sidebar-content")).toBeInTheDocument();
    expect(screen.getAllByTestId("sidebar-group").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Close global navigation" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search global navigation" })).toHaveClass(
      "text-base",
    );
    expect(screen.queryByTestId("command")).not.toBeInTheDocument();
    expect(screen.queryByTestId("command-shortcut")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Drag to dismiss command palette" })).toBeNull();
  });

  it("expands mobile terminal and Git rows to show actions below their titles", async () => {
    mobileState.isMobile = true;
    const add = vi.fn();
    const open = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={[]}
        onSelectTab={vi.fn()}
        mobileSide="right"
        actions={[
          {
            id: "workspace:session:dev-server",
            label: "dev-server",
            description: "Terminal session",
            group: "Terminal sessions",
            shortcut: "Ctrl + 1",
            icon: "terminal",
            onSelect: add,
            options: [
              { id: "add", label: "Add", onSelect: add },
              { id: "open", label: "Open", onSelect: open },
            ],
          },
          {
            id: "workspace:git:hive",
            label: "hive",
            description: "kethalia/hive",
            group: "Git repositories",
            shortcut: "Ctrl + 2",
            icon: "search",
            onSelect: add,
            options: [{ id: "open", label: "Open", onSelect: open }],
          },
        ]}
      />,
    );

    expect(screen.getByText("dev-server")).toBeVisible();
    expect(screen.getByText("hive")).toBeVisible();
    expect(screen.queryByText("Ctrl + 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Ctrl + 2")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "dev-server actions" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mobile-command-disclosure-workspace:session:dev-server"));

    const terminalActions = await screen.findByRole("group", { name: "dev-server actions" });
    expect(terminalActions).toBeVisible();
    expect(terminalActions).toHaveTextContent("Add");
    expect(terminalActions).toHaveTextContent("Open");
    expect(add).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("mobile-command-option-workspace:session:dev-server-open"));
    expect(open).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("falls back to 100dvh when visualViewport is unavailable on mobile", () => {
    mobileState.isMobile = true;

    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    expect(screen.getByTestId("sheet-content")).toHaveStyle({ maxHeight: "100dvh" });
  });

  it("applies the mobile command tap-target class contract", () => {
    mobileState.isMobile = true;

    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    const command = screen.getByTestId("command");
    expect(command).toHaveClass("rounded-none", "bg-transparent", "shadow-none");
    expect(command.className).toContain("[&_[cmdk-input]]:h-12");
    expect(command.className).toContain("[&_[cmdk-item]]:py-3");
  });

  it("renders an accessible mobile drag handle above the search input", () => {
    mobileState.isMobile = true;

    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    const handle = screen.getByRole("button", { name: "Drag to dismiss command palette" });
    expect(handle).toHaveAttribute("type", "button");
    expect(handle).toHaveClass("h-11");
    expect(handle).toHaveStyle({ userSelect: NO_TOUCH_STYLE.userSelect });
    expect(handle.getAttribute("style")).toContain("-webkit-user-select: none");
    expect(handle).toHaveAttribute("data-use-drag-bound", "true");

    const sheetChildren = Array.from(screen.getByTestId("sheet-content").children);
    expect(sheetChildren.indexOf(handle)).toBeLessThan(
      sheetChildren.indexOf(screen.getByTestId("command")),
    );
  });

  it("closes the mobile sheet when the drag handle is clicked", () => {
    mobileState.isMobile = true;
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Drag to dismiss command palette" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("configures y-axis drag with passive false and binds only the handle", () => {
    mobileState.isMobile = true;

    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    expect(dragState.config).toMatchObject({
      axis: "y",
      eventOptions: { passive: false },
      filterTaps: true,
    });
    expect(screen.getByRole("button", { name: "Drag to dismiss command palette" })).toHaveAttribute(
      "data-use-drag-bound",
      "true",
    );
    expect(screen.getByTestId("sheet-content")).not.toHaveAttribute("data-use-drag-bound");
    expect(screen.getByTestId("command")).not.toHaveAttribute("data-use-drag-bound");
    expect(screen.getByTestId("command-list")).not.toHaveAttribute("data-use-drag-bound");
    expect(screen.getByTestId("command-item-hive-main")).not.toHaveAttribute("data-use-drag-bound");
  });

  it("moves the sheet while dragging down and dismisses past the distance threshold", () => {
    mobileState.isMobile = true;
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    const activeState = invokeDrag({
      active: true,
      movement: [0, DRAG_DISMISS_DISTANCE_PX + 12],
      velocity: [0, 0],
    });

    expect(
      (activeState.event as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault,
    ).toHaveBeenCalled();
    expect(screen.getByTestId("sheet-content")).toHaveStyle({
      transform: `translateY(${DRAG_DISMISS_DISTANCE_PX + 12}px)`,
      transition: "none",
    });

    invokeDrag({
      active: false,
      movement: [0, DRAG_DISMISS_DISTANCE_PX + 12],
      velocity: [0, 0],
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("sheet-content").style.transform).toBe("");
  });

  it("dismisses when downward release velocity crosses the threshold", () => {
    mobileState.isMobile = true;
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    invokeDrag({
      active: false,
      direction: [0, 1],
      movement: [0, 12],
      velocity: [0, DRAG_DISMISS_VELOCITY + 0.1],
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not close below threshold and snaps transform back to zero", () => {
    mobileState.isMobile = true;
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    invokeDrag({ active: true, movement: [0, 24], velocity: [0, 0] });
    expect(screen.getByTestId("sheet-content")).toHaveStyle({ transform: "translateY(24px)" });

    invokeDrag({ active: false, movement: [0, 24], velocity: [0, 0] });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sheet-content")).toHaveStyle({
      transform: "translateY(0px)",
      transition: "transform 150ms ease-out",
    });
  });

  it("clamps upward drags to zero movement", () => {
    mobileState.isMobile = true;
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    invokeDrag({ active: true, direction: [0, -1], movement: [0, -48], velocity: [0, 0] });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sheet-content").style.transform).toBe("");
  });

  it("treats malformed gesture state as zero movement and velocity", () => {
    mobileState.isMobile = true;
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    invokeDrag({ direction: undefined, movement: undefined, velocity: undefined });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sheet-content")).toHaveStyle({ transform: "translateY(0px)" });
  });

  it("disables drag transforms for reduced motion while preserving threshold dismissal", async () => {
    mobileState.isMobile = true;
    const mediaQuery = installMatchMedia(true);
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)"),
    );
    act(() => mediaQuery.dispatch(true));

    invokeDrag({ active: true, movement: [0, DRAG_DISMISS_DISTANCE_PX + 8], velocity: [0, 0] });

    expect(screen.getByTestId("sheet-content").style.transform).toBe("");
    expect(screen.getByTestId("sheet-content").style.transition).toBe("");

    invokeDrag({ active: false, movement: [0, DRAG_DISMISS_DISTANCE_PX + 8], velocity: [0, 0] });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("sheet-content").style.transform).toBe("");
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

  it("keeps session selection callbacks working in the mobile sheet", () => {
    mobileState.isMobile = true;
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
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders custom command actions before sessions and closes after selection", () => {
    const action = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
        actions={[
          {
            id: "workspace:new",
            label: "New terminal session named api",
            description: "Create and focus this session in the workspace",
            group: "Actions",
            value: "api new terminal session",
            shortcut: "Ctrl + Shift + N",
            rightLabel: "Workspace",
            icon: "plus",
            onSelect: action,
          },
        ]}
      />,
    );

    const groups = screen.getAllByTestId(/command-group-/);
    expect(groups[0]).toHaveAttribute("data-heading", "Actions");
    expect(screen.getByText("New terminal session named api")).toBeInTheDocument();
    expect(screen.getByText("Create and focus this session in the workspace")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("command-item-api new terminal session"));

    expect(action).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("chooses and runs a row action with Left, Right, and Enter while search stays focused", () => {
    const add = vi.fn();
    const open = vi.fn();
    const vscode = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={[]}
        onSelectTab={vi.fn()}
        actions={[
          {
            id: "workspace:session:dev",
            label: "dev",
            group: "Terminal sessions",
            onSelect: add,
            options: [
              { id: "add", label: "Add", onSelect: add },
              { id: "open", label: "Open", onSelect: open },
              { id: "vscode", label: "VS Code", onSelect: vscode },
              { id: "filebrowser", label: "Files", onSelect: vi.fn() },
            ],
          },
        ]}
      />,
    );

    const item = screen.getByText("dev").closest('[cmdk-item=""]');
    expect(item).not.toBeNull();
    if (!item) return;
    expect(item).toHaveAttribute("tabindex", "0");
    item.setAttribute("aria-selected", "true");
    const input = screen.getByTestId("command-input");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(input).toHaveFocus();
    expect(screen.getByTestId("command-option-workspace:session:dev-vscode")).toHaveAttribute(
      "data-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vscode).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves Left and Right available when the selected row has no action options", () => {
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={[]}
        onSelectTab={vi.fn()}
        searchValue="dev"
        onSearchValueChange={vi.fn()}
        actions={[
          {
            id: "workspace:session:dev",
            label: "dev",
            group: "Terminal sessions",
            onSelect: vi.fn(),
          },
        ]}
      />,
    );

    const item = screen
      .getByText("dev", { selector: "[cmdk-item] span" })
      .closest('[cmdk-item=""]');
    expect(item).not.toBeNull();
    item?.setAttribute("aria-selected", "true");
    const input = screen.getByTestId("command-input");
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("runs a specific option when its visible label is clicked", () => {
    const add = vi.fn();
    const vscode = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        open={true}
        onOpenChange={onOpenChange}
        tabs={[]}
        onSelectTab={vi.fn()}
        actions={[
          {
            id: "workspace:session:dev",
            label: "dev",
            group: "Terminal sessions",
            onSelect: add,
            options: [
              { id: "add", label: "Add", onSelect: add },
              { id: "vscode", label: "VS Code", onSelect: vscode },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("command-option-workspace:session:dev-vscode"));
    expect(vscode).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps arrow navigation stable when every row option is disabled", () => {
    const action = vi.fn();
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={[]}
        onSelectTab={vi.fn()}
        actions={[
          {
            id: "workspace:session:disabled",
            label: "disabled",
            group: "Terminal sessions",
            onSelect: action,
            options: [
              { id: "add", label: "Add", disabled: true, onSelect: action },
              { id: "open", label: "Open", disabled: true, onSelect: action },
            ],
          },
        ]}
      />,
    );

    const item = screen.getByText("disabled").closest('[cmdk-item=""]');
    expect(item).not.toBeNull();
    if (!item) return;
    item.setAttribute("aria-selected", "true");
    fireEvent.keyDown(item, { key: "ArrowRight" });
    fireEvent.click(item);
    expect(action).not.toHaveBeenCalled();
  });

  it("controls search input value when search props are provided", () => {
    const onSearchValueChange = vi.fn();

    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        tabs={mockTabs}
        onSelectTab={vi.fn()}
        searchValue="api"
        onSearchValueChange={onSearchValueChange}
      />,
    );

    const input = screen.getByTestId("command-input");
    expect(input).toHaveValue("api");
    fireEvent.change(input, { target: { value: "worker" } });
    expect(onSearchValueChange).toHaveBeenCalledWith("worker");
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
    expect(screen.getByTestId("command-shortcut")).toHaveTextContent("Ctrl + Shift + N");
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

  it("keeps New Session callbacks working in the mobile sheet", () => {
    mobileState.isMobile = true;
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
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    expect(screen.queryByText("New Session")).not.toBeInTheDocument();
  });

  it("displays session names with correct text", () => {
    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    expect(screen.getByText("hive-main")).toBeInTheDocument();
    expect(screen.getByText("dev-server")).toBeInTheDocument();
    expect(screen.getByText("test-runner")).toBeInTheDocument();
  });

  it("renders Sessions group heading", () => {
    render(
      <CommandPalette open={true} onOpenChange={vi.fn()} tabs={mockTabs} onSelectTab={vi.fn()} />,
    );

    expect(screen.getByTestId("command-group-sessions")).toBeInTheDocument();
  });
});
