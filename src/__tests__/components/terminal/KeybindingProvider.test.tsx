// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";
import type { KeybindingContextValue } from "@/hooks/useKeybindings";
import { useKeybindings } from "@/hooks/useKeybindings";
import { TERMINAL_FOCUS_ACTIVE_EVENT } from "@/lib/terminal/events";

vi.mock("@/lib/terminal/actions", () => ({
  copyTerminalSelection: vi.fn(() => false),
}));

function makeKeyEvent(opts: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", opts);
}

describe("KeybindingProvider", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderWithProbe(children?: React.ReactNode) {
    let context: KeybindingContextValue | null = null;

    function Probe() {
      context = useKeybindings();
      return null;
    }

    render(
      <KeybindingProvider>
        <Probe />
        {children}
      </KeybindingProvider>,
    );

    return {
      get context() {
        return context;
      },
    };
  }

  it("registers copy but leaves keyboard paste to native terminal handling", async () => {
    const probe = renderWithProbe();

    await waitFor(() => {
      expect(probe.context?.getAll().some((entry) => entry.id === "copy")).toBe(true);
    });

    const entries = probe.context?.getAll() ?? [];
    expect(entries.map((entry) => entry.id)).toContain("copy");
    expect(entries.map((entry) => entry.id)).not.toContain("paste");
    expect(entries.flatMap((entry) => entry.keys)).not.toContain("ctrl+v");
    expect(entries.flatMap((entry) => entry.keys)).not.toContain("cmd+v");
    expect(probe.context?.handleKeyEvent(makeKeyEvent({ key: "v", ctrlKey: true }))).toBe(true);
    expect(probe.context?.handleKeyEvent(makeKeyEvent({ key: "v", metaKey: true }))).toBe(true);
  });

  it("handles registered global shortcuts at the window level", async () => {
    const probe = renderWithProbe();
    const action = vi.fn(() => false);

    act(() => {
      probe.context?.register({
        id: "command-palette",
        keys: ["ctrl+k", "cmd+k"],
        action,
        description: "Open command palette",
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      });
    });

    const event = makeKeyEvent({ key: "k", metaKey: true, bubbles: true, cancelable: true });
    const stopImmediatePropagation = vi.spyOn(event, "stopImmediatePropagation");

    act(() => {
      window.dispatchEvent(event);
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it("does not capture global shortcuts from ordinary text-entry fields", async () => {
    const action = vi.fn(() => false);
    const probe = renderWithProbe(<input aria-label="Search sessions" />);

    act(() => {
      probe.context?.register({
        id: "command-palette",
        keys: ["ctrl+k", "cmd+k"],
        action,
        description: "Open command palette",
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      });
    });

    const input = document.querySelector("input");
    expect(input).not.toBeNull();
    const event = makeKeyEvent({ key: "k", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      input?.dispatchEvent(event);
    });

    expect(action).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not capture global shortcuts from contenteditable fields", async () => {
    const action = vi.fn(() => false);
    const probe = renderWithProbe(
      <div>
        <div data-testid="plain-editor" />
        <div contentEditable="plaintext-only" data-testid="plaintext-editor" />
      </div>,
    );

    act(() => {
      probe.context?.register({
        id: "command-palette",
        keys: ["ctrl+k", "cmd+k"],
        action,
        description: "Open command palette",
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      });
    });

    const plainEditor = document.querySelector('[data-testid="plain-editor"]');
    const plaintextEditor = document.querySelector('[data-testid="plaintext-editor"]');
    expect(plainEditor).not.toBeNull();
    expect(plaintextEditor).not.toBeNull();
    plainEditor?.setAttribute("contenteditable", "");

    const plainEvent = makeKeyEvent({ key: "k", metaKey: true, bubbles: true, cancelable: true });
    const plaintextEvent = makeKeyEvent({
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      plainEditor?.dispatchEvent(plainEvent);
      plaintextEditor?.dispatchEvent(plaintextEvent);
    });

    expect(action).not.toHaveBeenCalled();
    expect(plainEvent.defaultPrevented).toBe(false);
    expect(plaintextEvent.defaultPrevented).toBe(false);
  });

  it("still captures global shortcuts from the xterm helper textarea", async () => {
    const action = vi.fn(() => false);
    const probe = renderWithProbe(
      <div className="xterm">
        <textarea aria-label="Terminal input" className="xterm-helper-textarea" />
      </div>,
    );

    act(() => {
      probe.context?.register({
        id: "command-palette",
        keys: ["ctrl+k", "cmd+k"],
        action,
        description: "Open command palette",
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      });
    });

    const textarea = document.querySelector("textarea");
    expect(textarea).not.toBeNull();
    const event = makeKeyEvent({ key: "k", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      textarea?.dispatchEvent(event);
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("captures exact global workspace board chords from the xterm helper textarea", async () => {
    const action = vi.fn(() => false);
    const probe = renderWithProbe(
      <div className="xterm">
        <textarea aria-label="Terminal input" className="xterm-helper-textarea" />
      </div>,
    );

    act(() => {
      probe.context?.register({
        id: "multi-session:test-workspace:next-board",
        keys: ["ctrl+alt+arrowright", "cmd+alt+arrowright"],
        action,
        description: "Switch to next workspace board",
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      });
    });

    const textarea = document.querySelector("textarea");
    expect(textarea).not.toBeNull();

    for (const event of [
      makeKeyEvent({
        key: "ArrowRight",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
      makeKeyEvent({
        key: "ArrowRight",
        metaKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ]) {
      const stopImmediatePropagation = vi.spyOn(event, "stopImmediatePropagation");

      act(() => {
        textarea?.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
    }

    expect(action).toHaveBeenCalledTimes(2);
  });

  it("lets nearby non-board input pass through from the xterm helper textarea", async () => {
    const action = vi.fn(() => false);
    const probe = renderWithProbe(
      <div className="xterm">
        <textarea aria-label="Terminal input" className="xterm-helper-textarea" />
      </div>,
    );

    act(() => {
      probe.context?.register({
        id: "multi-session:test-workspace:next-board",
        keys: ["ctrl+alt+arrowright", "cmd+alt+arrowright"],
        action,
        description: "Switch to next workspace board",
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      });
    });

    const textarea = document.querySelector("textarea");
    expect(textarea).not.toBeNull();

    const unmatchedEvents = [
      makeKeyEvent({ key: "ArrowRight", bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "ArrowLeft", bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "ArrowRight", metaKey: true, bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "a", bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "v", ctrlKey: true, bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "v", metaKey: true, bubbles: true, cancelable: true }),
    ];

    for (const event of unmatchedEvents) {
      const stopImmediatePropagation = vi.spyOn(event, "stopImmediatePropagation");

      act(() => {
        textarea?.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(false);
      expect(stopImmediatePropagation).not.toHaveBeenCalled();
    }

    expect(action).not.toHaveBeenCalled();
  });

  it("does not capture non-global shortcuts at the window level", async () => {
    const probe = renderWithProbe();
    const action = vi.fn(() => false);

    act(() => {
      probe.context?.register({
        id: "copy-test",
        keys: ["ctrl+c", "cmd+c"],
        action,
        description: "Copy selection",
        category: "clipboard",
        enabledInBrowser: true,
      });
    });

    const event = makeKeyEvent({ key: "c", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(action).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("focuses the active terminal when sidebar toggles request terminal focus", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const probe = renderWithProbe();
    const terminal = { focus: vi.fn() } as unknown as Terminal;

    act(() => {
      probe.context?.setActiveTerminal(terminal, vi.fn());
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(TERMINAL_FOCUS_ACTIVE_EVENT));
    });

    expect(terminal.focus).toHaveBeenCalledTimes(1);
  });
});
