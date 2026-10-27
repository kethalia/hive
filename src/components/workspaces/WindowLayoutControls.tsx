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
  const nextMode = manager.mode === "grid" ? "strip" : "grid";
  return (
    <WorkspaceHeaderButton
      label={nextMode === "grid" ? "Switch to Grid view" : "Switch to Strip view"}
      onClick={() => onAction(nextMode)}
    >
      {nextMode === "grid" ? <LayoutGrid className="size-4" /> : <Columns3 className="size-4" />}
    </WorkspaceHeaderButton>
  );
}
