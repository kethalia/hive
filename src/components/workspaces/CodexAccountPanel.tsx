"use client";

import { useState } from "react";
import type { CodexAccountSection } from "./AccountWorkspacePanel";
import { CodexAccountCard } from "./CodexAccountCard";
import { CodexLibraryPanel } from "./CodexLibraryPanel";
import { CodexUsageSettings } from "./CodexUsageSettings";

export function CodexAccountPanel({
  workspaceId,
  buildId,
  section,
  directorySession,
  managementBusy,
  onBusyChange,
  onSessionSkills,
  onWorkspaceSkills,
}: {
  workspaceId: string;
  buildId: string;
  section: CodexAccountSection;
  directorySession?: string;
  managementBusy: boolean;
  onBusyChange: (busy: boolean) => void;
  onSessionSkills: (id: string) => void;
  onWorkspaceSkills: () => void;
}) {
  const [generation, setGeneration] = useState<{ lifetimeId: string; value: number }>();
  return (
    <CodexAccountCard
      workspaceId={workspaceId}
      buildId={buildId}
      managementBusy={managementBusy}
      showConnection={section === "connection"}
    >
      {(status, controls) => {
        if (section === "connection") return null;
        const scope = `${workspaceId}/${buildId}/${status.lifetimeId}`;
        const props = {
          workspaceId,
          buildId,
          lifetimeId: status.lifetimeId,
          generation: Math.max(
            status.generation,
            generation?.lifetimeId === status.lifetimeId ? generation.value : 0,
          ),
          disabled: controls.busy,
          onBusyChange,
          onAccountRefresh: controls.refresh,
          onGeneration: (value: number) => setGeneration({ lifetimeId: status.lifetimeId, value }),
        };
        return section === "usage" || section === "config" ? (
          <CodexUsageSettings key={scope} section={section} {...props} />
        ) : (
          <CodexLibraryPanel
            key={`${scope}/${section}/${directorySession ?? ""}`}
            section={section}
            sessionId={section === "skills" ? directorySession : undefined}
            onSessionSkills={onSessionSkills}
            onWorkspaceSkills={onWorkspaceSkills}
            {...props}
          />
        );
      }}
    </CodexAccountCard>
  );
}
