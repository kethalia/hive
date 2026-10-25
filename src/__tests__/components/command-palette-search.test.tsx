// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type CommandPaletteAction } from "@/components/terminal/CommandPalette";

// Keep real cmdk filtering, DOM sorting, selection, and keyboard handling.
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
