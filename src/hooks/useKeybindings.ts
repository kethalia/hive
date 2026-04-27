import * as React from "react";
import type { Terminal } from "@xterm/xterm";

export interface KeybindingEntry {
  id: string;
  keys: string[];
  action: (
    term: Terminal | null,
    send: ((data: string) => void) | null,
  ) => boolean;
  description: string;
  category: string;
  enabledInBrowser: boolean;
}

export interface KeybindingContextValue {
  register(entry: KeybindingEntry): void;
  unregister(id: string): void;
  getAll(): KeybindingEntry[];
  handleKeyEvent(e: KeyboardEvent): boolean;
  activeTerminal: Terminal | null;
  activeSend: ((data: string) => void) | null;
  setActiveTerminal(
    term: Terminal | null,
    send: ((data: string) => void) | null,
  ): void;
}

const MODIFIER_ORDER = ["ctrl", "cmd", "alt", "shift"] as const;

export function normalizeKeyCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.metaKey) parts.push("cmd");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.sort(
    (a, b) =>
      MODIFIER_ORDER.indexOf(a as (typeof MODIFIER_ORDER)[number]) -
      MODIFIER_ORDER.indexOf(b as (typeof MODIFIER_ORDER)[number]),
  );
  const key = e.key.toLowerCase();
  if (!["control", "meta", "alt", "shift"].includes(key)) {
    parts.push(key);
  }
  return parts.join("+");
}

export const KeybindingContext =
  React.createContext<KeybindingContextValue | null>(null);

export function useKeybindings(): KeybindingContextValue {
  const ctx = React.useContext(KeybindingContext);
  if (!ctx) {
    throw new Error("useKeybindings must be used within a KeybindingProvider");
  }
  return ctx;
}

export function useRegisterKeybinding(entry: KeybindingEntry) {
  const { register, unregister } = useKeybindings();

  React.useEffect(() => {
    register(entry);
    return () => unregister(entry.id);
  }, [entry.id, register, unregister]);
}
