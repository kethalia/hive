"use client";

import { Columns3, LayoutGrid } from "lucide-react";
import type { WindowManager } from "@/lib/workspaces/window-manager";
import { WorkspaceHeaderButton } from "./WorkspaceHeaderButton";

export function WindowLayoutControls({
  manager,
  onAction,
}: {
  manager: WindowManager;
  onAction: (id: string) => void;
}) {
  return (
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
    </div>
  );
}
