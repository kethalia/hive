"use client";

import { AccountMaintenanceCard } from "./AccountMaintenanceCard";
import { ClaudeAccountCard } from "./ClaudeAccountCard";
import { CodexAccountCard } from "./CodexAccountCard";

export function AccountsPanel({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Connect Codex and Claude in the selected workspace.
      </p>
      <AccountMaintenanceCard workspaceId={workspaceId} />
      <ClaudeAccountCard workspaceId={workspaceId} />
      <CodexAccountCard workspaceId={workspaceId} />
    </div>
  );
}
