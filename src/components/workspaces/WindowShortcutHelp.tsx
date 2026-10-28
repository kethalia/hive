"use client";

import { useId, useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRegisterKeybindingHelp } from "@/hooks/useKeybindings";
import type { WindowManager } from "@/lib/workspaces/window-manager";

const shortcutOptions = [
  { value: "primary+alt", label: "On — platform shortcuts" },
  { value: "off", label: "Off — use buttons and search" },
] as const;

export function WindowShortcutHelp({
  shortcuts,
  onChange,
}: {
  shortcuts: WindowManager["shortcuts"];
  onChange: (shortcuts: WindowManager["shortcuts"]) => void;
}) {
  const selectId = useId();
  const content = useMemo(
    () => (
      <section
        className="space-y-3 rounded-md border border-border p-3"
        aria-label="Window layout help"
      >
        <div className="flex flex-col gap-2 text-sm">
          <label htmlFor={selectId}>Layout shortcuts</label>
          <Select
            value={shortcuts}
            items={shortcutOptions}
            onValueChange={(value) => {
              if (value) onChange(value);
            }}
          >
            <SelectTrigger id={selectId} aria-label="Layout shortcuts" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {shortcutOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          Cmd/Ctrl+Arrow focuses windows. Add Option/Alt with Left/Right to switch numbered
          workspaces. Drag title bars to move windows and divider grips to resize, including on
          touch screens. The last Strip column can grow from its left grip. All layout actions are
          also in Cmd/Ctrl+K, even when shortcuts are off.
        </p>
        <p className="text-xs text-muted-foreground">
          Embedded apps keep their own keyboard focus. Focus the pane header or use Hive search to
          arrange them. Shortcuts use Command on macOS and Control on Windows/Linux, never both.
        </p>
      </section>
    ),
    [shortcuts, onChange, selectId],
  );
  useRegisterKeybindingHelp("window-layout", content);
  return null;
}
