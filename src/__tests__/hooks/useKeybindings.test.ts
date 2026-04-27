// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as React from "react";
import {
  normalizeKeyCombo,
  KeybindingContext,
  useKeybindings,
  useRegisterKeybinding,
  type KeybindingContextValue,
  type KeybindingEntry,
} from "@/hooks/useKeybindings";

function makeKeyEvent(
  opts: Partial<KeyboardEventInit> & { key: string },
): KeyboardEvent {
  return new KeyboardEvent("keydown", opts);
}

describe("normalizeKeyCombo", () => {
  it("normalizes ctrl+c", () => {
    const e = makeKeyEvent({ key: "c", ctrlKey: true });
    expect(normalizeKeyCombo(e)).toBe("ctrl+c");
  });

  it("normalizes cmd+c (meta)", () => {
    const e = makeKeyEvent({ key: "c", metaKey: true });
    expect(normalizeKeyCombo(e)).toBe("cmd+c");
  });

  it("normalizes cmd+shift+k with consistent modifier order", () => {
    const e = makeKeyEvent({ key: "k", metaKey: true, shiftKey: true });
    expect(normalizeKeyCombo(e)).toBe("cmd+shift+k");
  });

  it("normalizes ctrl+alt+shift+t with correct ordering", () => {
    const e = makeKeyEvent({
      key: "t",
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(normalizeKeyCombo(e)).toBe("ctrl+alt+shift+t");
  });

  it("normalizes all four modifiers in fixed order", () => {
    const e = makeKeyEvent({
      key: "x",
      ctrlKey: true,
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(normalizeKeyCombo(e)).toBe("ctrl+cmd+alt+shift+x");
  });

  it("excludes bare modifier keys from output", () => {
    const e = makeKeyEvent({ key: "Control", ctrlKey: true });
    expect(normalizeKeyCombo(e)).toBe("ctrl");
  });

  it("lowercases the key", () => {
    const e = makeKeyEvent({ key: "K", metaKey: true });
    expect(normalizeKeyCombo(e)).toBe("cmd+k");
  });

  it("returns just the key when no modifiers", () => {
    const e = makeKeyEvent({ key: "a" });
    expect(normalizeKeyCombo(e)).toBe("a");
  });
});

function createMockContextValue(): KeybindingContextValue {
  const registry = new Map<string, KeybindingEntry>();
  return {
    register: vi.fn((entry: KeybindingEntry) => {
      for (const key of entry.keys) {
        registry.set(key, entry);
      }
    }),
    unregister: vi.fn((id: string) => {
      for (const [key, entry] of registry) {
        if (entry.id === id) registry.delete(key);
      }
    }),
    getAll: vi.fn(() => {
      const seen = new Set<string>();
      const entries: KeybindingEntry[] = [];
      for (const entry of registry.values()) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          entries.push(entry);
        }
      }
      return entries;
    }),
    handleKeyEvent: vi.fn(() => true),
    activeTerminal: null,
    activeSend: null,
    setActiveTerminal: vi.fn(),
  };
}

describe("useKeybindings", () => {
  it("throws when used outside provider", () => {
    expect(() => {
      renderHook(() => useKeybindings());
    }).toThrow("useKeybindings must be used within a KeybindingProvider");
  });

  it("returns context value when inside provider", () => {
    const mockValue = createMockContextValue();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        KeybindingContext.Provider,
        { value: mockValue },
        children,
      );

    const { result } = renderHook(() => useKeybindings(), { wrapper });
    expect(result.current).toBe(mockValue);
  });
});

describe("useRegisterKeybinding", () => {
  it("registers on mount and unregisters on unmount", () => {
    const mockValue = createMockContextValue();
    const entry: KeybindingEntry = {
      id: "test-binding",
      keys: ["ctrl+t"],
      action: () => false,
      description: "Test",
      category: "test",
      enabledInBrowser: true,
    };

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        KeybindingContext.Provider,
        { value: mockValue },
        children,
      );

    const { unmount } = renderHook(() => useRegisterKeybinding(entry), {
      wrapper,
    });

    expect(mockValue.register).toHaveBeenCalledWith(entry);

    unmount();
    expect(mockValue.unregister).toHaveBeenCalledWith("test-binding");
  });
});

describe("registry integration via context mock", () => {
  let ctx: KeybindingContextValue;

  beforeEach(() => {
    ctx = createMockContextValue();
  });

  it("register adds entry, getAll returns it", () => {
    const entry: KeybindingEntry = {
      id: "copy",
      keys: ["ctrl+c", "cmd+c"],
      action: () => false,
      description: "Copy",
      category: "clipboard",
      enabledInBrowser: true,
    };
    ctx.register(entry);
    const all = ctx.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("copy");
  });

  it("unregister removes entry", () => {
    const entry: KeybindingEntry = {
      id: "paste",
      keys: ["ctrl+v"],
      action: () => false,
      description: "Paste",
      category: "clipboard",
      enabledInBrowser: true,
    };
    ctx.register(entry);
    expect(ctx.getAll()).toHaveLength(1);
    ctx.unregister("paste");
    expect(ctx.getAll()).toHaveLength(0);
  });

  it("multiple keys per entry map to same action", () => {
    const entry: KeybindingEntry = {
      id: "copy",
      keys: ["ctrl+c", "cmd+c"],
      action: () => false,
      description: "Copy",
      category: "clipboard",
      enabledInBrowser: true,
    };
    ctx.register(entry);
    const all = ctx.getAll();
    expect(all).toHaveLength(1);
  });
});
