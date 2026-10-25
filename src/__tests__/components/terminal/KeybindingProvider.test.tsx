// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";
import type { KeybindingContextValue } from "@/hooks/useKeybindings";
import { useKeybindings } from "@/hooks/useKeybindings";
import { copyTerminalSelection } from "@/lib/terminal/actions";
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

  it("restores a previous shortcut owner when an overlay unregisters", () => {
    const probe = renderWithProbe();
    const first = vi.fn(() => false),
      second = vi.fn(() => false);
    const base = {
      keys: ["ctrl+alt+r"],
      description: "Resize",
      category: "workspace",
      enabledInBrowser: true,
      global: true,
    };
    act(() => {
      probe.context?.register({ ...base, id: "base", action: first });
      probe.context?.register({ ...base, id: "overlay", action: second });
    });
    const event = () => makeKeyEvent({ key: "r", ctrlKey: true, altKey: true });
    probe.context?.handleKeyEvent(event());
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    act(() => probe.context?.unregister("overlay"));
    probe.context?.handleKeyEvent(event());
    expect(first).toHaveBeenCalledOnce();
  });

  it("registers copy but leaves keyboard paste to native terminal handling", async () => {
    const probe = renderWithProbe();

    await waitFor(() => {
      expect(probe.context?.getAll().some((entry) => entry.id === "copy")).toBe(true);
      expect(probe.context?.getAll().some((entry) => entry.id === "tmux-menu")).toBe(true);
    });

    const entries = probe.context?.getAll() ?? [];
    expect(entries.map((entry) => entry.id)).toContain("copy");
    expect(entries.map((entry) => entry.id)).toContain("tmux-menu");
    expect(entries.map((entry) => entry.id)).toContain("paste");
    expect(entries.flatMap((entry) => entry.keys)).toContain("ctrl+v");
    expect(entries.flatMap((entry) => entry.keys)).toContain("cmd+v");
    expect(entries.flatMap((entry) => entry.keys)).toContain("ctrl+shift+v");
    expect(entries.flatMap((entry) => entry.keys)).toContain("cmd+shift+v");
    expect(probe.context?.handleKeyEvent(makeKeyEvent({ key: "v", ctrlKey: true }))).toBe(true);
    expect(probe.context?.handleKeyEvent(makeKeyEvent({ key: "v", metaKey: true }))).toBe(true);
    expect(
      probe.context?.handleKeyEvent(makeKeyEvent({ key: "V", ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("publishes stable shortcut snapshots and notifies subscribers of additions and removals", () => {
    const probe = renderWithProbe();
    const context = probe.context!;
    const initial = context.getAll();
    expect(context.getAll()).toBe(initial);
    const listener = vi.fn();
    const unsubscribe = context.subscribe!(listener);
    const entry = {
      id: "workspace:create",
      keys: ["ctrl+t", "cmd+t", "ctrl+alt+t", "cmd+alt+t"],
      action: () => false,
      description: "Create numbered workspace",
      category: "terminal",
      enabledInBrowser: true,
    };
    act(() => context.register(entry));
    expect(listener).toHaveBeenCalledTimes(1);
    const updated = context.getAll();
    expect(updated).not.toBe(initial);
    expect(context.getAll()).toBe(updated);
    expect(updated.filter((item) => item.id === entry.id)).toEqual([entry]);
    act(() => context.unregister(entry.id));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(context.getAll().some((item) => item.id === entry.id)).toBe(false);
    unsubscribe();
    act(() => context.register(entry));
    expect(listener).toHaveBeenCalledTimes(2);
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

  it.each([
    { key: "ŧ", code: "KeyT" },
    { key: "w", code: "KeyW" },
  ])("passes AltGr input through global and terminal shortcut handlers: $code", ({ key, code }) => {
    const probe = renderWithProbe(
      <div className="xterm">
        <textarea className="xterm-helper-textarea" />
      </div>,
    );
    const action = vi.fn(() => false);
    act(() =>
      probe.context?.register({
        id: "workspace-shortcut",
        keys: ["ctrl+alt+t", "ctrl+alt+w"],
        action,
        description: "Manage workspace",
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      }),
    );
    const event = makeKeyEvent({
      key,
      code,
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => document.querySelector("textarea")?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(probe.context?.handleKeyEvent(event)).toBe(true);
    expect(action).not.toHaveBeenCalled();
    const shortcut = makeKeyEvent({
      key: code.slice(3).toLowerCase(),
      code,
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => document.querySelector("textarea")?.dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(true);
    expect(action).toHaveBeenCalledOnce();
  });

  it("skips global shortcuts that were already handled by a capture fallback", async () => {
    const probe = renderWithProbe();
    const action = vi.fn(() => false);

    act(() => {
      probe.context?.register({
        id: "workspace-index",
        keys: ["ctrl+1", "cmd+1"],
        action,
        description: "Switch workspace",
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      });
    });

    const event = makeKeyEvent({ key: "1", ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault();

    act(() => {
      window.dispatchEvent(event);
    });

    expect(action).not.toHaveBeenCalled();
    expect(probe.context?.handleKeyEvent(event)).toBe(false);
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

  it("captures opted-in global shortcuts from ordinary text-entry fields", async () => {
    const action = vi.fn(() => false);
    const probe = renderWithProbe(<input aria-label="Search sessions" />);

    act(() => {
      probe.context?.register({
        id: "dashboard:command-palette",
        keys: ["ctrl+k", "cmd+k"],
        action,
        description: "Open command palette",
        category: "general",
        enabledInBrowser: true,
        global: true,
        allowTextEntry: true,
      });
    });

    const input = document.querySelector("input");
    expect(input).not.toBeNull();
    const event = makeKeyEvent({ key: "k", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      input?.dispatchEvent(event);
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
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

  it("opens the tmux menu from the xterm helper textarea", async () => {
    const send = vi.fn();
    const probe = renderWithProbe(
      <div className="xterm">
        <textarea aria-label="Terminal input" className="xterm-helper-textarea" />
      </div>,
    );

    await waitFor(() => {
      expect(probe.context?.getAll().some((entry) => entry.id === "tmux-menu")).toBe(true);
    });

    act(() => {
      probe.context?.setActiveTerminal({ focus: vi.fn() } as unknown as Terminal, send);
    });

    const textarea = document.querySelector("textarea");
    expect(textarea).not.toBeNull();

    for (const event of [
      makeKeyEvent({ key: "m", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "m", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    ]) {
      const stopImmediatePropagation = vi.spyOn(event, "stopImmediatePropagation");

      act(() => {
        textarea?.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
    }

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, "\u001b[24~");
    expect(send).toHaveBeenNthCalledWith(2, "\u001b[24~");
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

  it("lets terminal Ctrl+C pass through when no text is selected", async () => {
    vi.mocked(copyTerminalSelection).mockReturnValueOnce(true);
    const probe = renderWithProbe();
    const terminal = new Terminal();
    vi.spyOn(terminal, "getSelection").mockReturnValue("");
    vi.spyOn(terminal, "clearSelection").mockImplementation(() => {});

    act(() => {
      probe.context?.setActiveTerminal(terminal, vi.fn());
    });

    const result = probe.context?.handleKeyEvent(makeKeyEvent({ key: "c", ctrlKey: true }));

    expect(result).toBe(true);
    expect(copyTerminalSelection).toHaveBeenCalledWith(terminal);
  });

  it("consumes terminal Ctrl+C for copy when text is selected", async () => {
    vi.mocked(copyTerminalSelection).mockReturnValueOnce(false);
    const probe = renderWithProbe();
    const terminal = new Terminal();
    vi.spyOn(terminal, "getSelection").mockReturnValue("selected");
    vi.spyOn(terminal, "clearSelection").mockImplementation(() => {});

    act(() => {
      probe.context?.setActiveTerminal(terminal, vi.fn());
    });

    const result = probe.context?.handleKeyEvent(makeKeyEvent({ key: "c", ctrlKey: true }));

    expect(result).toBe(false);
    expect(copyTerminalSelection).toHaveBeenCalledWith(terminal);
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
  it.each([
    ["microphone", "m"],
    ["speaker", "s"],
    ["actions", "."],
    ["close", "x"],
  ])("routes the %s shortcut to the focused pane exactly once", (control, key) => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 32, 32),
    ] as unknown as DOMRectList);
    const first = vi.fn();
    const second = vi.fn();
    const probe = renderWithProbe(
      <>
        <div data-terminal-audio-frame="true" data-active="false">
          <button type="button" data-terminal-control={control} onClick={first}>
            First
          </button>
        </div>
        <div data-terminal-audio-frame="true" data-active="true">
          <textarea className="xterm-helper-textarea" aria-label="Terminal input" />
          <button type="button" data-terminal-control={control} onClick={second}>
            Second
          </button>
        </div>
      </>,
    );
    const input = document.querySelector("textarea")!;
    input.focus();
    const event = makeKeyEvent({
      key,
      code: `Key${key.toUpperCase()}`,
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    // Holding the shortcut must not repeat the action or close another pane.
    expect(
      probe.context?.handleKeyEvent(
        makeKeyEvent({ key, ctrlKey: true, altKey: true, repeat: true }),
      ),
    ).toBe(false);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    act(() =>
      input.dispatchEvent(
        makeKeyEvent({ key, ctrlKey: true, altKey: true, repeat: true, bubbles: true }),
      ),
    );
    expect(second).toHaveBeenCalledOnce();
    act(() =>
      input.dispatchEvent(
        makeKeyEvent({
          key: "≈",
          code: `Key${control === "actions" ? "P" : key.toUpperCase()}`,
          metaKey: true,
          altKey: true,
          bubbles: true,
        }),
      ),
    );
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("does not close a pane through a dialog or act on a hidden parked pane", () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 32, 32),
    ] as unknown as DOMRectList);
    const close = vi.fn();
    renderWithProbe(
      <>
        <div data-terminal-audio-frame="true" data-active="true" aria-hidden="true">
          <button type="button" data-terminal-control="close" onClick={close}>
            Hidden close
          </button>
        </div>
        <div data-terminal-audio-frame="true" data-active="true">
          <button type="button" data-terminal-control="close" onClick={close}>
            Visible close
          </button>
        </div>
        <div role="dialog">
          <button type="button">Dialog control</button>
        </div>
      </>,
    );
    const event = () =>
      makeKeyEvent({ key: "x", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(event()));
    expect(close).not.toHaveBeenCalled();
    document.querySelector('[role="dialog"]')!.setAttribute("hidden", "");
    document.querySelectorAll("[data-terminal-audio-frame]")[1].setAttribute("inert", "");
    act(() => window.dispatchEvent(event()));
    expect(close).not.toHaveBeenCalled();
  });
});
