"use client";

import type { Terminal } from "@xterm/xterm";
import * as React from "react";
import {
  KeybindingContext,
  type KeybindingContextValue,
  type KeybindingEntry,
  normalizeKeyCombo,
} from "@/hooks/useKeybindings";
import {
  isTerminalHelperTextAreaTarget,
  isTextEntryEventTarget,
} from "@/lib/keyboard-event-targets";
import { PANE_CONTROL_SHORTCUTS } from "@/lib/keyboard-shortcuts";
import { copyTerminalSelection } from "@/lib/terminal/actions";
import { TERMINAL_FOCUS_ACTIVE_EVENT } from "@/lib/terminal/events";
import { activatePaneControl } from "@/lib/terminal/pane-controls";
import { isPwaStandalone } from "@/lib/terminal/pwa";

const TMUX_MENU_KEY_SEQUENCE = "\u001b[24~";

export function KeybindingProvider({ children }: { children: React.ReactNode }) {
  const registryRef = React.useRef<Map<string, KeybindingEntry>>(new Map());
  const entriesRef = React.useRef<KeybindingEntry[]>([]);
  const listenersRef = React.useRef(new Set<() => void>());
  const [activeTerminal, setActiveTerminalState] = React.useState<Terminal | null>(null);
  const [activeSend, setActiveSendState] = React.useState<((data: string) => void) | null>(null);

  const publish = React.useCallback(() => {
    const entries = new Map<string, KeybindingEntry>();
    for (const entry of registryRef.current.values()) entries.set(entry.id, entry);
    entriesRef.current = [...entries.values()];
    for (const listener of listenersRef.current) listener();
  }, []);

  const register = React.useCallback(
    (entry: KeybindingEntry) => {
      for (const key of entry.keys) {
        registryRef.current.set(key, entry);
      }
      publish();
    },
    [publish],
  );

  const unregister = React.useCallback(
    (id: string) => {
      let changed = false;
      for (const [key, entry] of registryRef.current) {
        if (entry.id === id) {
          registryRef.current.delete(key);
          changed = true;
        }
      }
      if (changed) publish();
    },
    [publish],
  );

  const getAll = React.useCallback(() => entriesRef.current, []);
  const subscribe = React.useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const handleKeyEvent = React.useCallback(
    (e: KeyboardEvent): boolean => {
      if (e.defaultPrevented) return false;
      const combo = normalizeKeyCombo(e);
      const entry = registryRef.current.get(combo);
      if (!entry) return true;
      if (e.repeat && entry.allowRepeat === false) return false;
      return entry.action(activeTerminal, activeSend);
    },
    [activeTerminal, activeSend],
  );

  const setActiveTerminal = React.useCallback(
    (term: Terminal | null, send: ((data: string) => void) | null) => {
      setActiveTerminalState(term);
      setActiveSendState(() => send);
    },
    [],
  );

  const value = React.useMemo<KeybindingContextValue>(
    () => ({
      register,
      unregister,
      getAll,
      subscribe,
      handleKeyEvent,
      activeTerminal,
      activeSend,
      setActiveTerminal,
    }),
    [
      register,
      unregister,
      getAll,
      subscribe,
      handleKeyEvent,
      activeTerminal,
      activeSend,
      setActiveTerminal,
    ],
  );

  React.useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const combo = normalizeKeyCombo(event);
      const entry = registryRef.current.get(combo);
      if (!entry?.global) return;
      if (
        isTextEntryEventTarget(event.target) &&
        !isTerminalHelperTextAreaTarget(event.target) &&
        !entry.allowTextEntry
      ) {
        return;
      }
      if (!entry.enabledInBrowser && !isPwaStandalone()) return;

      const shouldContinue =
        event.repeat && entry.allowRepeat === false
          ? false
          : entry.action(activeTerminal, activeSend);
      if (!shouldContinue) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, { capture: true });
  }, [activeSend, activeTerminal]);

  React.useEffect(() => {
    const handleFocusActiveTerminal = () => {
      window.requestAnimationFrame(() => {
        activeTerminal?.focus();
      });
    };

    window.addEventListener(TERMINAL_FOCUS_ACTIVE_EVENT, handleFocusActiveTerminal);
    return () => window.removeEventListener(TERMINAL_FOCUS_ACTIVE_EVENT, handleFocusActiveTerminal);
  }, [activeTerminal]);

  React.useEffect(() => {
    // Native/xterm paste owns execution; register its chord for shortcut help.
    register({
      id: "paste",
      keys: ["ctrl+v", "cmd+v", "ctrl+shift+v", "cmd+shift+v"],
      action: () => true,
      description: "Paste text or files into terminal",
      category: "clipboard",
      enabledInBrowser: true,
    });
    register({
      id: "copy",
      keys: ["ctrl+c", "cmd+c"],
      action: (term) => {
        if (!term) return true;
        return copyTerminalSelection(term);
      },
      description: "Copy selection",
      category: "clipboard",
      enabledInBrowser: true,
    });
    return () => {
      unregister("copy");
      unregister("paste");
    };
  }, [register, unregister]);

  React.useEffect(() => {
    register({
      id: "tmux-menu",
      keys: ["ctrl+shift+m", "cmd+shift+m"],
      action: (_term, send) => {
        if (!send) return true;
        send(TMUX_MENU_KEY_SEQUENCE);
        return false;
      },
      description: "Open tmux menu",
      category: "terminal",
      enabledInBrowser: true,
      global: true,
    });
    return () => {
      unregister("tmux-menu");
    };
  }, [register, unregister]);

  React.useEffect(() => {
    const controls = Object.keys(PANE_CONTROL_SHORTCUTS) as (keyof typeof PANE_CONTROL_SHORTCUTS)[];
    for (const control of controls) {
      const shortcut = PANE_CONTROL_SHORTCUTS[control];
      register({
        id: `pane-control:${control}`,
        keys: [...shortcut.keys],
        action: (term) => activatePaneControl(control, term?.element),
        description: shortcut.label,
        category: "terminal",
        enabledInBrowser: true,
        global: true,
        allowRepeat: false,
      });
    }
    return () => {
      for (const control of controls) unregister(`pane-control:${control}`);
    };
  }, [register, unregister]);

  return <KeybindingContext.Provider value={value}>{children}</KeybindingContext.Provider>;
}

export default KeybindingProvider;
