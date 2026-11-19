"use client";

import { Activity, BookOpen, Link2, List, Plug, Puzzle, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { PanelTabs, type PanelTabsNavigation } from "@/components/ui/panel-tabs";
import { CodexAccountCard } from "./CodexAccountCard";
import { CodexLibraryPanel } from "./CodexLibraryPanel";
import { CodexUsageSettings } from "./CodexUsageSettings";

const sections = [
  { id: "connection", label: "Connection", icon: <Link2 /> },
  { id: "usage", label: "Usage", icon: <Activity /> },
  { id: "config", label: "Runtime settings", icon: <SlidersHorizontal /> },
  { id: "skills", label: "Skills", icon: <BookOpen /> },
  { id: "plugins", label: "Plugins", icon: <Puzzle /> },
  { id: "sessions", label: "Sessions", icon: <List /> },
  { id: "integrations", label: "Integrations", icon: <Plug /> },
] as const;

export function CodexAccountPanel({
  workspaceId,
  buildId,
  navigation,
}: {
  workspaceId: string;
  buildId: string;
  navigation: PanelTabsNavigation;
}) {
  const [section, setSection] = useState<(typeof sections)[number]["id"]>("connection");
  const [directorySession, setDirectorySession] = useState<string>();
  const [managementBusy, setManagementBusy] = useState(false);
  const [generation, setGeneration] = useState<{ lifetimeId: string; value: number }>();
  return (
    <div className="@container flex min-w-0 flex-1 flex-col">
      <PanelTabs
        label="Codex settings"
        items={sections}
        value={section}
        onChange={(next) => {
          setDirectorySession(undefined);
          setSection(next);
        }}
        busy={managementBusy}
        navigation={navigation}
      >
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
              onBusyChange: setManagementBusy,
              onAccountRefresh: controls.refresh,
              onGeneration: (value: number) =>
                setGeneration({ lifetimeId: status.lifetimeId, value }),
            };
            return section === "usage" || section === "config" ? (
              <CodexUsageSettings key={scope} section={section} {...props} />
            ) : (
              <CodexLibraryPanel
                key={`${scope}/${section}/${directorySession ?? ""}`}
                section={section}
                sessionId={section === "skills" ? directorySession : undefined}
                onSessionSkills={(id) => {
                  setDirectorySession(id);
                  setSection("skills");
                }}
                onWorkspaceSkills={() => setDirectorySession(undefined)}
                {...props}
              />
            );
          }}
        </CodexAccountCard>
      </PanelTabs>
    </div>
  );
}
