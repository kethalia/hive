"use client";

import type { Terminal } from "@xterm/xterm";
import * as React from "react";

export interface KeybindingEntry {
  id: string;
  keys: string[];
  action: (term: Terminal | null, send: ((data: string) => void) | null) => boolean;
  description: string;
  category: string;
  enabledInBrowser: boolean;
  global?: boolean;
  allowTextEntry?: boolean;
}

export interface KeybindingContextValue {
  register(entry: KeybindingEntry): void;
  unregister(id: string): void;
  getAll(): KeybindingEntry[];
  handleKeyEvent(e: KeyboardEvent): boolean;
  activeTerminal: Terminal | null;
  activeSend: ((data: string) => void) | null;
  setActiveTerminal(term: Terminal | null, send: ((data: string) => void) | null): void;
}

const MODIFIER_ORDER = ["ctrl", "cmd", "alt", "shift"] as const;

function normalizeShortcutKey(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  if (["control", "meta", "alt", "shift"].includes(key)) return "";

  if (key === "left" || e.code === "ArrowLeft") return "arrowleft";
  if (key === "right" || e.code === "ArrowRight") return "arrowright";
  if (key === "up" || e.code === "ArrowUp") return "arrowup";
  if (key === "down" || e.code === "ArrowDown") return "arrowdown";

  const digitMatch = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (digitMatch) return digitMatch[1];

  return key;
}

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
  const key = normalizeShortcutKey(e);
  if (key) {
    parts.push(key);
  }
  return parts.join("+");
}

export const KeybindingContext = React.createContext<KeybindingContextValue | null>(null);

const NOOP_KEYBINDINGS: KeybindingContextValue = {
  register: () => {},
  unregister: () => {},
  getAll: () => [],
  handleKeyEvent: () => true,
  activeTerminal: null,
  activeSend: null,
  setActiveTerminal: () => {},
};

export function useKeybindings(): KeybindingContextValue {
  const ctx = React.useContext(KeybindingContext);
  return ctx ?? NOOP_KEYBINDINGS;
}

export function useRegisterKeybinding(entry: KeybindingEntry) {
  const { register, unregister } = useKeybindings();

  const actionRef = React.useRef(entry.action);
  actionRef.current = entry.action;

  const { id, description, category, enabledInBrowser, global, allowTextEntry } = entry;
  const keysKey = entry.keys.join(",");

  React.useEffect(() => {
    const keys = keysKey.split(",");
    const stableEntry: KeybindingEntry = {
      id,
      keys,
      description,
      category,
      enabledInBrowser,
      global,
      allowTextEntry,
      action: (term, send) => actionRef.current(term, send),
    };
    register(stableEntry);
    return () => unregister(id);
  }, [
    id,
    keysKey,
    description,
    category,
    enabledInBrowser,
    global,
    allowTextEntry,
    register,
    unregister,
  ]);
}
