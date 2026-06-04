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
import { copyTerminalSelection } from "@/lib/terminal/actions";
import { TERMINAL_FOCUS_ACTIVE_EVENT } from "@/lib/terminal/events";
import { isPwaStandalone } from "@/lib/terminal/pwa";

export function KeybindingProvider({ children }: { children: React.ReactNode }) {
  const registryRef = React.useRef<Map<string, KeybindingEntry>>(new Map());
  const [activeTerminal, setActiveTerminalState] = React.useState<Terminal | null>(null);
  const [activeSend, setActiveSendState] = React.useState<((data: string) => void) | null>(null);

  const register = React.useCallback((entry: KeybindingEntry) => {
    for (const key of entry.keys) {
      registryRef.current.set(key, entry);
    }
  }, []);

  const unregister = React.useCallback((id: string) => {
    for (const [key, entry] of registryRef.current) {
      if (entry.id === id) {
        registryRef.current.delete(key);
      }
    }
  }, []);

  const getAll = React.useCallback((): KeybindingEntry[] => {
    const seen = new Set<string>();
    const entries: KeybindingEntry[] = [];
    for (const entry of registryRef.current.values()) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        entries.push(entry);
      }
    }
    return entries;
  }, []);

  const handleKeyEvent = React.useCallback(
    (e: KeyboardEvent): boolean => {
      const combo = normalizeKeyCombo(e);
      const entry = registryRef.current.get(combo);
      if (!entry) return true;
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
      handleKeyEvent,
      activeTerminal,
      activeSend,
      setActiveTerminal,
    }),
    [register, unregister, getAll, handleKeyEvent, activeTerminal, activeSend, setActiveTerminal],
  );

  React.useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const combo = normalizeKeyCombo(event);
      const entry = registryRef.current.get(combo);
      if (!entry?.global) return;
      if (isTextEntryEventTarget(event.target) && !isTerminalHelperTextAreaTarget(event.target)) {
        return;
      }
      if (!entry.enabledInBrowser && !isPwaStandalone()) return;

      const shouldContinue = entry.action(activeTerminal, activeSend);
      if (!shouldContinue) {
        event.preventDefault();
        event.stopPropagation();
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
    };
  }, [register, unregister]);

  return <KeybindingContext.Provider value={value}>{children}</KeybindingContext.Provider>;
}

export default KeybindingProvider;
