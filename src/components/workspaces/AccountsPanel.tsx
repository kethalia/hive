"use client";

import { useState } from "react";
import { ClaudeAccountCard } from "./ClaudeAccountCard";
import { CodexAccountCard } from "./CodexAccountCard";
import { CodexUsageSettings } from "./CodexUsageSettings";

export function AccountsPanel({ workspaceId, buildId }: { workspaceId: string; buildId: string }) {
  const [managementBusy, setManagementBusy] = useState(false);
  return (
    <div className="space-y-5">
      <ClaudeAccountCard workspaceId={workspaceId} buildId={buildId} />
      <CodexAccountCard workspaceId={workspaceId} buildId={buildId} managementBusy={managementBusy}>
        {(status, controls) => (
          <CodexUsageSettings
            key={`${workspaceId}/${buildId}/${status.lifetimeId}`}
            workspaceId={workspaceId}
            buildId={buildId}
            lifetimeId={status.lifetimeId}
            generation={status.generation}
            disabled={controls.busy}
            onBusyChange={setManagementBusy}
            onAccountRefresh={controls.refresh}
          />
        )}
      </CodexAccountCard>
    </div>
  );
}
