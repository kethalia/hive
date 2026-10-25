"use client";

import { useMemo } from "react";
import { useRegisterKeybindingHelp } from "@/hooks/useKeybindings";
import type { WindowManager } from "@/lib/workspaces/window-manager";

export function WindowShortcutHelp({
  shortcuts,
  onChange,
}: {
  shortcuts: WindowManager["shortcuts"];
  onChange: (shortcuts: WindowManager["shortcuts"]) => void;
}) {
  const content = useMemo(
    () => (
      <section
        className="space-y-3 rounded-md border border-border p-3"
        aria-label="Window layout help"
      >
        <label className="flex flex-col gap-2 text-sm">
          Layout shortcuts
          <select
            className="rounded border bg-background p-2"
            value={shortcuts}
            onChange={(event) => onChange(event.target.value as WindowManager["shortcuts"])}
          >
            <option value="primary+alt">On — Cmd + Option / Ctrl + Alt</option>
            <option value="off">Off — use buttons and search</option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          Drag dividers to resize; double-click to reset. Layout shortcuts below apply to the
          current board. All layout actions are also in Cmd/Ctrl+K, even when shortcuts are off.
        </p>
        <p className="text-xs text-muted-foreground">
          Embedded apps keep their own keyboard focus. Focus the pane header or use Hive search to
          arrange them. Shortcuts use Command on macOS and Control on Windows/Linux, never both.
        </p>
      </section>
    ),
    [shortcuts, onChange],
  );
  useRegisterKeybindingHelp("window-layout", content);
  return null;
}
