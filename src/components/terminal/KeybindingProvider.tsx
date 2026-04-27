import * as React from "react";
import type { Terminal } from "@xterm/xterm";
import {
  KeybindingContext,
  normalizeKeyCombo,
  type KeybindingContextValue,
  type KeybindingEntry,
} from "@/hooks/useKeybindings";

export function KeybindingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const registryRef = React.useRef<Map<string, KeybindingEntry>>(new Map());
  const [activeTerminal, setActiveTerminalState] =
    React.useState<Terminal | null>(null);
  const [activeSend, setActiveSendState] = React.useState<
    ((data: string) => void) | null
  >(null);

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
    [
      register,
      unregister,
      getAll,
      handleKeyEvent,
      activeTerminal,
      activeSend,
      setActiveTerminal,
    ],
  );

  return (
    <KeybindingContext.Provider value={value}>
      {children}
    </KeybindingContext.Provider>
  );
}

export default KeybindingProvider;
