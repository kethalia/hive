"use client";

import {
  Activity,
  BookOpen,
  Link2,
  List,
  LoaderCircle,
  Play,
  Plug,
  Puzzle,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import dynamic from "next/dynamic";
import { Suspense, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { PanelTabs, type PanelTabsNavigation } from "@/components/ui/panel-tabs";
import type { CoderWorkspace } from "@/lib/coder/types";
import { requestHiveWindow } from "@/lib/workspaces/general-workspace";

const CodexAccountPanel = dynamic(() =>
  import("./CodexAccountPanel").then((m) => m.CodexAccountPanel),
);
const ClaudeAccountCard = dynamic(() =>
  import("./ClaudeAccountCard").then((m) => m.ClaudeAccountCard),
);

const commonSections = [
  { id: "workspace", label: "Workspace", icon: <Server /> },
  { id: "connection", label: "Connection", icon: <Link2 /> },
] as const;
const codexSections = [
  { id: "usage", label: "Usage", icon: <Activity /> },
  { id: "config", label: "Runtime settings", icon: <SlidersHorizontal /> },
  { id: "skills", label: "Skills", icon: <BookOpen /> },
  { id: "plugins", label: "Plugins", icon: <Puzzle /> },
  { id: "sessions", label: "Sessions", icon: <List /> },
  { id: "integrations", label: "Integrations", icon: <Plug /> },
] as const;
const codexTabs = [...commonSections, ...codexSections];
type Section = (typeof codexTabs)[number]["id"];
export type CodexAccountSection = Exclude<Section, "workspace">;

export function AccountWorkspacePanel({
  provider,
  userId,
  workspaces,
  workspaceId,
  buildId,
  navigation,
  visible,
  onStartWorkspace,
  onWorkspaceChange,
}: {
  provider: "Codex" | "Claude";
  userId: string;
  workspaces: CoderWorkspace[];
  workspaceId?: string;
  buildId?: string;
  navigation: PanelTabsNavigation;
  visible: boolean;
  onStartWorkspace: (workspaceId: string) => Promise<void>;
  onWorkspaceChange: (workspaceId: string, buildId: string) => void;
}) {
  const radioGroup = useId();
  const [selection, setSelection] = useState<{
    section: Section;
    directory?: { scope: string; sessionId: string };
  }>({
    section: "connection",
  });
  const [managementBusy, setManagementBusy] = useState(false);
  const [startup, setStartup] = useState<{ id: string; pending: boolean } | null>(null);
  const workspace = workspaceId
    ? workspaces.find((item) => item.id === workspaceId)
    : (workspaces.find((item) => item.latest_build.status === "running") ?? workspaces[0]);
  const status = workspace?.latest_build.status;
  const starting = startup?.id === workspace?.id && startup?.pending === true;
  const startFailed = startup?.id === workspace?.id && startup?.pending === false;
  const ready =
    !!workspace &&
    status === "running" &&
    buildId === workspace.latest_build.id &&
    !starting &&
    !startFailed;
  const section = ready ? selection.section : "workspace";
  const scope = `${userId}/${workspace?.id ?? ""}/${buildId ?? ""}`;

  async function start(workspaceId: string) {
    setStartup({ id: workspaceId, pending: true });
    try {
      await onStartWorkspace(workspaceId);
      setStartup(null);
      setSelection({ section: "connection" });
    } catch {
      setStartup({ id: workspaceId, pending: false });
    }
  }

  return (
    <div className="flex min-h-full min-w-0 flex-col" data-mobile-scroll-allow="true">
      <PanelTabs
        label={`${provider} settings`}
        items={provider === "Codex" ? codexTabs : commonSections}
        value={section}
        onChange={(section) => setSelection({ section })}
        busy={!ready || managementBusy}
        navigation={navigation}
      >
        {section === "workspace" ? (
          <div className="space-y-3">
            {workspaces.length > 0 && (
              <fieldset disabled={starting} className="min-w-0 space-y-2">
                <legend className="text-sm">Coder workspaces</legend>
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                  {workspaces.map((item) => (
                    <label
                      key={item.id}
                      className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/50 has-checked:bg-accent has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring has-disabled:cursor-default"
                    >
                      <input
                        type="radio"
                        name={radioGroup}
                        aria-label={`${item.name}, ${item.latest_build.status}`}
                        className="shrink-0 accent-primary"
                        checked={item.id === workspace?.id}
                        onChange={() => {
                          setStartup(null);
                          setSelection({ section: "workspace" });
                          onWorkspaceChange(item.id, item.latest_build.id);
                        }}
                      />
                      <span className="min-w-0 flex-1 break-all">{item.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.latest_build.status}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {starting ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                Starting {workspace?.name}…
              </p>
            ) : workspace && (status === "stopped" || startFailed) ? (
              <>
                {startFailed && (
                  <p role="alert" className="text-sm text-destructive">
                    Could not open {workspace.name}.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {(status === "stopped" || status === "running") && (
                    <Button onClick={() => void start(workspace.id)}>
                      <Play aria-hidden />
                      {status === "running" ? "Retry" : "Start workspace"}
                    </Button>
                  )}
                  {startFailed && (
                    <Button
                      variant="outline"
                      onClick={() => requestHiveWindow({ tool: "workspaces" })}
                    >
                      Coder workspaces
                    </Button>
                  )}
                </div>
              </>
            ) : workspace && status === "running" && !ready ? (
              <>
                <p role="status">Select this workspace’s current build to manage accounts.</p>
                <Button
                  onClick={() => {
                    onWorkspaceChange(workspace.id, workspace.latest_build.id);
                    setSelection({ section: "connection" });
                  }}
                >
                  Use current build
                </Button>
              </>
            ) : !ready ? (
              <p role="status" className="text-sm text-muted-foreground">
                {!workspace
                  ? workspaces.length
                    ? "The selected workspace is unavailable. Choose another workspace."
                    : "No workspaces available."
                  : status === "starting" || status === "pending"
                    ? "Waiting for the workspace to start…"
                    : `Workspace is ${status}. Manage it in Coder workspaces.`}
              </p>
            ) : null}
          </div>
        ) : visible && workspace && buildId ? (
          <Suspense
            fallback={
              <p role="status" className="text-muted-foreground">
                Loading {provider}…
              </p>
            }
          >
            {provider === "Codex" ? (
              <CodexAccountPanel
                key={scope}
                workspaceId={workspace.id}
                buildId={buildId}
                section={section}
                directorySession={
                  selection.directory?.scope === scope ? selection.directory.sessionId : undefined
                }
                managementBusy={managementBusy}
                onBusyChange={setManagementBusy}
                onSessionSkills={(sessionId) =>
                  setSelection({ section: "skills", directory: { scope, sessionId } })
                }
                onWorkspaceSkills={() => setSelection({ section: "skills" })}
              />
            ) : (
              <ClaudeAccountCard key={scope} workspaceId={workspace.id} buildId={buildId} />
            )}
          </Suspense>
        ) : null}
      </PanelTabs>
    </div>
  );
}
