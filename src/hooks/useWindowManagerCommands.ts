"use client";
import { useEffect, useMemo, useRef } from "react";
import type { CommandPaletteAction } from "@/components/terminal/CommandPalette";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { WINDOW_ACTIONS, windowActionKeys } from "@/lib/workspaces/window-actions";
import type { WindowManager } from "@/lib/workspaces/window-manager";
import { useKeybindings } from "./useKeybindings";

const BOARD_ACTIONS = [
  { id: "create-board", label: "Create workspace", keys: ["ctrl+alt+enter", "cmd+alt+enter"] },
  {
    id: "close-board",
    label: "Close current workspace",
    keys: ["ctrl+w", "cmd+w", "ctrl+alt+backspace", "cmd+alt+backspace"],
  },
  {
    id: "board-previous",
    label: "Previous workspace",
    keys: ["ctrl+alt+arrowleft", "cmd+alt+arrowleft", "ctrl+alt+pageup", "cmd+alt+pageup"],
  },
  {
    id: "board-next",
    label: "Next workspace",
    keys: ["ctrl+alt+arrowright", "cmd+alt+arrowright", "ctrl+alt+pagedown", "cmd+alt+pagedown"],
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `board-${i + 1}`,
    label: `Switch to workspace ${i + 1}`,
    keys: [`ctrl+${i + 1}`, `cmd+${i + 1}`],
  })),
];
export function useWindowManagerCommands(manager: WindowManager, run: (id: string) => void) {
  const { register, unregister } = useKeybindings();
  const runRef = useRef(run);
  runRef.current = run;
  const { mode, shortcuts } = manager;
  const actions = useMemo(
    () => [
      ...WINDOW_ACTIONS.map((a) => ({
        ...a,
        keys: windowActionKeys(a, shortcuts),
        category: "window layout",
        disabled: !!a.stripOnly && mode !== "strip",
      })),
      ...BOARD_ACTIONS.map((a) => ({
        ...a,
        category: "workspaces",
        disabled: false,
        repeat: false,
      })),
    ],
    [mode, shortcuts],
  );
  useEffect(() => {
    for (const a of actions) {
      if (a.disabled || !a.keys.length) continue;
      register({
        id: `window-manager:${a.id}`,
        keys: a.keys,
        description: a.label,
        category: a.category,
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
    return () => {
      for (const a of actions) unregister(`window-manager:${a.id}`);
    };
  }, [actions, register, unregister]);
  return useMemo<CommandPaletteAction[]>(
    () =>
      actions
        .filter((a) => !a.disabled)
        .map((a) => ({
          id: `window-manager:${a.id}`,
          label: a.label,
          group: "Arrange windows",
          shortcut: a.keys.length ? formatShortcut(a.keys) : undefined,
          onSelect: () => runRef.current(a.id),
        })),
    [actions],
  );
}
