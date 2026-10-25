"use client";
import { useEffect, useRef } from "react";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { registerGlobalCommandPaletteSource } from "@/lib/terminal/global-command-palette";
import { WINDOW_ACTIONS, windowActionKeys } from "@/lib/workspaces/window-actions";
import type { WindowManager } from "@/lib/workspaces/window-manager";
import { useKeybindings } from "./useKeybindings";

const BOARD_ACTIONS = [
  { id: "create-board", label: "Create board", keys: ["ctrl+alt+enter", "cmd+alt+enter"] },
  {
    id: "close-board",
    label: "Close current board",
    keys: ["ctrl+alt+backspace", "cmd+alt+backspace"],
  },
  { id: "board-previous", label: "Previous board", keys: ["ctrl+alt+pageup", "cmd+alt+pageup"] },
  { id: "board-next", label: "Next board", keys: ["ctrl+alt+pagedown", "cmd+alt+pagedown"] },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `board-${i + 1}`,
    label: `Switch to board ${i + 1}`,
    keys: [`ctrl+${i + 1}`, `cmd+${i + 1}`],
  })),
];
export function useWindowManagerCommands(manager: WindowManager, run: (id: string) => void) {
  const { register, unregister } = useKeybindings();
  const runRef = useRef(run);
  runRef.current = run;
  const { mode, shortcuts } = manager;
  useEffect(() => {
    const actions = [
      ...WINDOW_ACTIONS.map((a) => ({
        ...a,
        keys: windowActionKeys(a, shortcuts),
        disabled: !!a.stripOnly && mode !== "strip",
      })),
      ...BOARD_ACTIONS.map((a) => ({ ...a, disabled: false, repeat: false })),
    ];
    for (const a of actions) {
      if (a.disabled || !a.keys.length) continue;
      register({
        id: `window-manager:${a.id}`,
        keys: a.keys,
        description: a.label,
        category: "workspace",
        enabledInBrowser: true,
        global: true,
        allowRepeat: a.repeat ?? false,
        action: () => {
          // Layout shortcuts must not act behind a modal dialog.
          if (
            document.querySelector(
              '[role="dialog"][aria-modal="true"], [data-slot="dialog-content"]',
            )
          )
            return true;
          runRef.current(a.id);
          return false;
        },
      });
    }
    const cleanup = registerGlobalCommandPaletteSource({
      id: "window-manager",
      actions: actions
        .filter((a) => !a.disabled)
        .map((a) => ({
          id: `window-manager:${a.id}`,
          label: a.label,
          group: "Arrange windows",
          shortcut: a.keys.length ? formatShortcut(a.keys) : undefined,
          onSelect: () => runRef.current(a.id),
        })),
    });
    return () => {
      for (const a of actions) unregister(`window-manager:${a.id}`);
      cleanup();
    };
  }, [mode, shortcuts, register, unregister]);
}
