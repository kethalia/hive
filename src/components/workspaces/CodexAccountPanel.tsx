"use client";

import { useState } from "react";
import { CodexAccountCard } from "./CodexAccountCard";
import { CodexUsageSettings } from "./CodexUsageSettings";

export function CodexAccountPanel({
  workspaceId,
  buildId,
}: {
  workspaceId: string;
  buildId: string;
}) {
  const [managementBusy, setManagementBusy] = useState(false);
  return (
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
  );
}
