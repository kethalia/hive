"use client";
import { Columns3, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ShortcutTooltip } from "@/components/ui/shortcut-tooltip";
import { WINDOW_ACTIONS, windowActionKeys } from "@/lib/workspaces/window-actions";
import type { WindowManager } from "@/lib/workspaces/window-manager";
import { WorkspaceHeaderButton } from "./WorkspaceHeaderButton";

export function WindowLayoutControls({
  manager,
  onAction,
  onShortcuts,
}: {
  manager: WindowManager;
  onAction: (id: string) => void;
  onShortcuts: (preset: WindowManager["shortcuts"]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center gap-1" role="toolbar" aria-label="Window layout">
        <WorkspaceHeaderButton
          className="aria-pressed:bg-accent"
          label="Grid layout"
          aria-pressed={manager.mode === "grid"}
          onClick={() => onAction("grid")}
        >
          <LayoutGrid className="size-4" />
        </WorkspaceHeaderButton>
        <WorkspaceHeaderButton
          className="aria-pressed:bg-accent"
          label="Strip layout"
          aria-pressed={manager.mode === "strip"}
          onClick={() => onAction("strip")}
        >
          <Columns3 className="size-4" />
        </WorkspaceHeaderButton>
        <WorkspaceHeaderButton label="Arrange windows and shortcuts" onClick={() => setOpen(true)}>
          <SlidersHorizontal className="size-4" />
        </WorkspaceHeaderButton>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
          data-mobile-scroll-allow="true"
        >
          <DialogHeader>
            <DialogTitle>Arrange windows</DialogTitle>
            <DialogDescription>
              Drag dividers to resize. Double-click a divider to reset it. Every action is also in
              Cmd/Ctrl+K.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-2 text-sm">
            Layout shortcut modifier
            <select
              className="rounded border bg-background p-2"
              value={manager.shortcuts}
              onChange={(e) => onShortcuts(e.target.value as WindowManager["shortcuts"])}
            >
              <option value="ctrl+alt">Control + Option / Alt</option>
              <option value="ctrl+cmd">Control + Command / Meta</option>
              <option value="off">Off — use buttons and search</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            Embedded apps keep their own keyboard focus. Use the pane header or Hive search to
            arrange them. Control + Command avoids VoiceOver’s Control + Option modifier.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {WINDOW_ACTIONS.filter((a) => !a.id.startsWith("window-")).map((a) => (
              <ShortcutTooltip
                key={a.id}
                label={a.label}
                shortcuts={windowActionKeys(a, manager.shortcuts)}
                trigger={
                  <Button
                    variant="outline"
                    className="h-auto min-h-10 whitespace-normal text-left"
                    disabled={a.stripOnly && manager.mode !== "strip"}
                    onClick={() => {
                      setOpen(false);
                      onAction(a.id);
                    }}
                  >
                    {a.label}
                  </Button>
                }
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
