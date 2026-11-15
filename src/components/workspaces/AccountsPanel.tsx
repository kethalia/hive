"use client";

import { ClaudeAccountCard } from "./ClaudeAccountCard";
import { CodexAccountCard } from "./CodexAccountCard";

export function AccountsPanel({ workspaceId, buildId }: { workspaceId: string; buildId: string }) {
  return (
    <div className="space-y-5">
      <ClaudeAccountCard workspaceId={workspaceId} buildId={buildId} />
      <CodexAccountCard workspaceId={workspaceId} buildId={buildId} />
    </div>
  );
}
