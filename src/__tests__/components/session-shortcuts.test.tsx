// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import type { KeybindingEntry, KeybindingContextValue } from "@/hooks/useKeybindings";

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const Stub = ({ sessionName }: { sessionName: string }) => (
      <div data-testid={`terminal-${sessionName}`}>Terminal: {sessionName}</div>
    );
    Stub.displayName = "InteractiveTerminal";
    return Stub;
  },
}));

const mockCreateSession = vi.fn();
const mockKillSession = vi.fn();
const mockGetSessions = vi.fn();

vi.mock("@/lib/actions/workspaces", () => ({
  createSessionAction: (...args: unknown[]) => mockCreateSession(...args),
  renameSessionAction: vi.fn(),
  killSessionAction: (...args: unknown[]) => mockKillSession(...args),
  getWorkspaceSessionsAction: (...args: unknown[]) => mockGetSessions(...args),
}));

let mockPwaStandalone = false;
vi.mock("@/lib/terminal/pwa", () => ({
  isPwaStandalone: () => mockPwaStandalone,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <button onClick={onClick as React.MouseEventHandler} disabled={disabled as boolean} data-testid={rest["data-testid"] as string}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}));

vi.mock("lucide-react", () => ({
  X: () => <span>×</span>,
  Plus: () => <span>+</span>,
  Pencil: () => <span>✎</span>,
  Terminal: () => <span>⊞</span>,
}));

vi.mock("@/components/terminal/CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("@/components/workspaces/KeepAliveWarning", () => ({
  KeepAliveWarning: () => null,
}));

vi.mock("@/components/workspaces/InteractiveTerminal", () => ({
  connectionBadgeProps: () => ({ variant: "outline", label: "connected", className: "" }),
}));

const registeredBindings = new Map<string, KeybindingEntry>();

function createMockKeybindingsCtx(): KeybindingContextValue {
  return {
    register: vi.fn((entry: KeybindingEntry) => {
      registeredBindings.set(entry.id, entry);
    }),
    unregister: vi.fn((id: string) => {
      registeredBindings.delete(id);
    }),
    getAll: vi.fn(() => Array.from(registeredBindings.values())),
    handleKeyEvent: vi.fn(() => true),
    activeTerminal: null,
    activeSend: null,
    setActiveTerminal: vi.fn(),
  };
}

let mockCtx: KeybindingContextValue;

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: () => mockCtx,
  KeybindingContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
}));

import { TerminalTabManager } from "@/components/workspaces/TerminalTabManager";

const defaultProps = { agentId: "agent-1", workspaceId: "ws-1" };

describe("session keybinding registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredBindings.clear();
    mockPwaStandalone = false;
    mockCtx = createMockKeybindingsCtx();
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2)}`) });
  });

  afterEach(() => {
    cleanup();
  });

  async function renderWithTabs(sessions: Array<{ name: string }>) {
    mockGetSessions.mockResolvedValue({ data: sessions.map((s) => ({ ...s, created: 1000, windows: 1 })) });
    render(<TerminalTabManager {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("tab-label")).toHaveLength(sessions.length);
    });
    await waitFor(() => {
      expect(registeredBindings.size).toBe(5);
    });
  }

  it("registers all 5 session keybindings with correct ids and categories", async () => {
    await renderWithTabs([{ name: "s1" }]);

    const ids = Array.from(registeredBindings.keys());
    expect(ids).toContain("command-palette");
    expect(ids).toContain("session:create");
    expect(ids).toContain("session:close");
    expect(ids).toContain("session:next-tab");
    expect(ids).toContain("session:prev-tab");

    for (const entry of registeredBindings.values()) {
      expect(entry.category).toBe("session");
      expect(entry.enabledInBrowser).toBe(true);
    }
  });

  it("registers correct key combos for each binding", async () => {
    await renderWithTabs([{ name: "s1" }]);

    expect(registeredBindings.get("command-palette")!.keys).toEqual(["ctrl+k", "cmd+k"]);
    expect(registeredBindings.get("session:create")!.keys).toEqual(["ctrl+t", "cmd+t"]);
    expect(registeredBindings.get("session:close")!.keys).toEqual(["ctrl+w", "cmd+w"]);
    expect(registeredBindings.get("session:next-tab")!.keys).toEqual(["ctrl+tab"]);
    expect(registeredBindings.get("session:prev-tab")!.keys).toEqual(["ctrl+shift+tab"]);
  });

  describe("Ctrl+T (session:create)", () => {
    it("returns true (pass-through) when not in PWA standalone", async () => {
      mockPwaStandalone = false;
      await renderWithTabs([{ name: "s1" }]);

      const action = registeredBindings.get("session:create")!.action;
      const result = action(null, null);
      expect(result).toBe(true);
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("calls handleCreateTab and returns false when in PWA standalone", async () => {
      mockPwaStandalone = true;
      mockCreateSession.mockResolvedValue({ data: { name: "new-session" } });
      await renderWithTabs([{ name: "s1" }]);

      const action = registeredBindings.get("session:create")!.action;
      const result = action(null, null);
      expect(result).toBe(false);

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
      });
    });
  });

  describe("Ctrl+W (session:close)", () => {
    it("returns true (pass-through) when not in PWA standalone", async () => {
      await renderWithTabs([{ name: "s1" }, { name: "s2" }]);
      mockPwaStandalone = false;

      const action = registeredBindings.get("session:close")!.action;
      const result = action(null, null);
      expect(result).toBe(true);
      expect(mockKillSession).not.toHaveBeenCalled();
    });

    it("calls handleKillTab with activeTabId when PWA and multiple tabs", async () => {
      mockPwaStandalone = true;
      mockKillSession.mockResolvedValue({ data: { name: "s1" } });
      await renderWithTabs([{ name: "s1" }, { name: "s2" }]);

      const action = registeredBindings.get("session:close")!.action;
      const result = action(null, null);
      expect(result).toBe(false);

      await waitFor(() => {
        expect(mockKillSession).toHaveBeenCalled();
      });
    });

    it("returns true (no-op) when PWA but only one tab", async () => {
      mockPwaStandalone = true;
      await renderWithTabs([{ name: "s1" }]);

      const action = registeredBindings.get("session:close")!.action;
      const result = action(null, null);
      expect(result).toBe(true);
      expect(mockKillSession).not.toHaveBeenCalled();
    });
  });

  describe("Ctrl+Tab (session:next-tab)", () => {
    it("cycles to the next tab (wraps last to first)", async () => {
      const uuids = ["uuid-aaa", "uuid-bbb", "uuid-ccc"];
      let uuidIdx = 0;
      vi.stubGlobal("crypto", { randomUUID: () => uuids[uuidIdx++] });
      await renderWithTabs([{ name: "s1" }, { name: "s2" }, { name: "s3" }]);

      const action = registeredBindings.get("session:next-tab")!.action;
      const result = action(null, null);
      expect(result).toBe(false);
    });

    it("returns false but is no-op when single tab", async () => {
      await renderWithTabs([{ name: "s1" }]);

      const action = registeredBindings.get("session:next-tab")!.action;
      const result = action(null, null);
      expect(result).toBe(false);
    });
  });

  describe("Ctrl+Shift+Tab (session:prev-tab)", () => {
    it("cycles to the previous tab (wraps first to last)", async () => {
      await renderWithTabs([{ name: "s1" }, { name: "s2" }, { name: "s3" }]);

      const action = registeredBindings.get("session:prev-tab")!.action;
      const result = action(null, null);
      expect(result).toBe(false);
    });

    it("returns false but is no-op when single tab", async () => {
      await renderWithTabs([{ name: "s1" }]);

      const action = registeredBindings.get("session:prev-tab")!.action;
      const result = action(null, null);
      expect(result).toBe(false);
    });
  });

  describe("cleanup on unmount", () => {
    it("unregisters all keybindings on unmount", async () => {
      mockGetSessions.mockResolvedValue({ data: [{ name: "s1", created: 1000, windows: 1 }] });
      const { unmount } = render(<TerminalTabManager {...defaultProps} />);

      await waitFor(() => {
        expect(registeredBindings.size).toBeGreaterThan(0);
      });

      unmount();

      expect(mockCtx.unregister).toHaveBeenCalledWith("command-palette");
      expect(mockCtx.unregister).toHaveBeenCalledWith("session:create");
      expect(mockCtx.unregister).toHaveBeenCalledWith("session:close");
      expect(mockCtx.unregister).toHaveBeenCalledWith("session:next-tab");
      expect(mockCtx.unregister).toHaveBeenCalledWith("session:prev-tab");
    });
  });
});
