// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type CommandPaletteAction } from "@/components/terminal/CommandPalette";

// Keep the real cmdk registration, selection, and keyboard handling.
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const settings = {
  id: "settings",
  label: "Settings",
  group: "Hive",
  aliases: ["preferences"],
  onSelect: vi.fn(),
};
const desktop = {
  id: "desktop",
  label: "Desktop",
  group: "Desktops",
  value: "Desktop creator-direction-upgrade desktop app",
  onSelect: vi.fn(),
};
const selected = () =>
  document.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute("data-action-id");
const search = (query: string) =>
  fireEvent.change(screen.getByRole("combobox"), { target: { value: query } });
const order = () =>
  screen.queryAllByRole("option").map((item) => item.getAttribute("data-action-id"));
function Palette({ actions }: { actions: CommandPaletteAction[] }) {
  return (
    <CommandPalette open onOpenChange={vi.fn()} tabs={[]} onSelectTab={vi.fn()} actions={actions} />
  );
}

describe("real command search", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("filters unrelated entries, ranks across groups, and selects the first result with Enter", async () => {
    render(<Palette actions={[desktop, settings]} />);
    search("settings");
    await waitFor(() => expect(order()).toEqual(["settings"]));
    expect(selected()).toBe("settings");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(settings.onSelect).toHaveBeenCalledOnce();
    search("");
    await waitFor(() => expect(order()).toEqual(["desktop", "settings"]));
    search("preferences");
    await waitFor(() => expect(selected()).toBe("settings"));
  });

  it("keeps matching results visible when their metadata refreshes", async () => {
    const { rerender } = render(<Palette actions={[desktop, settings]} />);
    search("settings");
    await waitFor(() => expect(order()).toEqual(["settings"]));
    rerender(
      <Palette actions={[desktop, { ...settings, description: "Updated account preferences" }]} />,
    );
    await waitFor(() => expect(order()).toEqual(["settings"]));
    expect(selected()).toBe("settings");
  });

  it("preserves the selected second result and Enter target when its description refreshes", async () => {
    const first = { ...settings, id: "first", value: "settings", description: "First account" };
    const second = {
      ...settings,
      id: "second",
      value: "settings",
      description: "Second account",
      onSelect: vi.fn(),
    };
    const { rerender } = render(<Palette actions={[first, second]} />);
    search("settings");
    await waitFor(() => expect(selected()).toBe("first"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(selected()).toBe("second");
    const selectedNode = screen.getAllByRole("option")[1];
    rerender(<Palette actions={[first, { ...second, description: "Second account updated" }]} />);
    await waitFor(() => expect(screen.getByText("Second account updated")).toBeTruthy());
    expect(selected()).toBe("second");
    expect(screen.getAllByRole("option")[1]).toBe(selectedNode);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(second.onSelect).toHaveBeenCalledOnce();
    expect(first.onSelect).not.toHaveBeenCalled();
  });

  it("refreshes alias matches without a new keystroke and falls back when the selected match disappears", async () => {
    const first = { ...settings, id: "first", value: "account", aliases: ["preferences"] };
    const second = { ...desktop, id: "second", value: "workspace", aliases: ["preferences"] };
    const { rerender } = render(<Palette actions={[first, second]} />);
    search("preferences");
    await waitFor(() => expect(order()).toEqual(["first", "second"]));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(selected()).toBe("second");
    rerender(<Palette actions={[first, { ...second, aliases: [] }]} />);
    await waitFor(() => expect(order()).toEqual(["first"]));
    expect(selected()).toBe("first");
    rerender(
      <Palette
        actions={[
          { ...first, aliases: [] },
          { ...second, aliases: [] },
        ]}
      />,
    );
    await waitFor(() => expect(order()).toEqual([]));
    expect(screen.getByText("No sessions found.")).toBeTruthy();
    rerender(<Palette actions={[{ ...first, aliases: [] }, second]} />);
    await waitFor(() => expect(selected()).toBe("second"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(second.onSelect).toHaveBeenCalledOnce();
  });

  it("ranks legacy sessions and creation actions together with command actions", async () => {
    const selectTab = vi.fn();
    const createSession = vi.fn();
    render(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        tabs={[{ id: "tab", sessionName: "settings" }]}
        onSelectTab={selectTab}
        onCreateSession={createSession}
        actions={[{ ...settings, label: "Settings tools" }]}
      />,
    );
    search("settings");
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0].getAttribute("data-value")).toBe("tab:tab"),
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(selectTab).toHaveBeenCalledExactlyOnceWith("tab");
    search("new session");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getAllByRole("option")[0].getAttribute("data-value")).toBe("create-session");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("reorders async results without losing the user's keyboard selection", async () => {
    const weak = { id: "weak", label: "Codex tools", group: "Hive", onSelect: vi.fn() };
    const session = { id: "session", label: "codex", group: "Terminals", onSelect: vi.fn() };
    const { rerender } = render(<Palette actions={[weak, desktop]} />);
    search("codex");
    await waitFor(() => expect(selected()).toBe("weak"));
    rerender(<Palette actions={[weak, desktop, session]} />);
    await waitFor(() => expect(order()).toEqual(["session", "weak"]));
    search("codex ");
    await waitFor(() => expect(selected()).toBe("session"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(selected()).toBe("weak");
    rerender(
      <Palette
        actions={[
          weak,
          desktop,
          session,
          { id: "another", label: "codex-extra", group: "Terminals", onSelect: vi.fn() },
        ]}
      />,
    );
    await waitFor(() => expect(order()).toEqual(["session", "another", "weak"]));
    expect(selected()).toBe("weak");
  });
});
