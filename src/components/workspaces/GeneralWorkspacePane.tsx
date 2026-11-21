"use client";

import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import type { Terminal } from "@xterm/xterm";
import dynamic from "next/dynamic";
import { type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LoadingStatus } from "@/components/ui/loading-status";
import { TerminalSessionFrame } from "@/components/workspaces/TerminalSessionFrame";
import {
  type WorkspacePaneAction,
  WorkspacePaneActionSheet,
} from "@/components/workspaces/WorkspacePaneActionSheet";
import { resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import {
  getWorkspaceAppToolAction,
  getWorkspaceSessionToolsAction,
} from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import { useDiscovery } from "@/lib/discovery/queries";
import {
  WORKSPACE_APP_FRAME_ALLOW,
  WORKSPACE_APP_FRAME_SANDBOX,
} from "@/lib/security/workspace-app-isolation";
import { workspaceTemplateCapabilities } from "@/lib/templates/catalog";
import { terminalFontSizeScope } from "@/lib/terminal/font-size";
import { forgetTerminalViews, terminalPaneViewKey } from "@/lib/terminal/session-lifetime";
import { readDocumentCoderFrameHosts } from "@/lib/workspaces/document-frame-hosts";
import type {
  GeneralPane,
  GeneralWindow,
  GeneralWorkspaceTool,
} from "@/lib/workspaces/general-workspace";
import { requestHiveWindow } from "@/lib/workspaces/general-workspace";

const InteractiveTerminal = dynamic(
  () => import("./InteractiveTerminal").then((m) => m.InteractiveTerminal),
  { ssr: false },
);
interface Connection {
  agentId?: string;
  sessionName?: string;
  clonePath?: string;
  cloneProof?: string;
  url?: string;
  reloadRequired?: boolean;
  error?: string;
}
function ProjectLaunchFeedback({
  logs,
  error,
  onRetry,
}: {
  logs: readonly string[];
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex min-h-0 w-full max-w-xl flex-col gap-3 text-left">
      {error ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-destructive">
            {error}
          </p>
          {onRetry ? (
            <Button variant="outline" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : (
        <LoadingStatus>{logs.at(-1)}</LoadingStatus>
      )}
      <details className="min-h-0 rounded-md border border-border bg-background">
        <summary className="cursor-pointer px-3 py-2 text-muted-foreground">Logs</summary>
        <pre
          role="log"
          aria-live="off"
          aria-label="Project launch logs"
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-black/20 px-3 py-2 font-mono text-xs leading-relaxed"
        >
          {[...logs, ...(error ? [error] : [])].join("\n")}
        </pre>
      </details>
    </div>
  );
}

interface Props {
  pane: Exclude<GeneralWindow, { kind: "hive" }>;
  workspace?: CoderWorkspace;
  boardKey: string;
  active: boolean;
  visible: boolean;
  mobile: boolean;
  layoutSignal: string;
  dragHandleListeners?: DraggableSyntheticListeners;
  onActivate: () => void;
  onClose: () => void;
  onCycleWidth?: () => void;
  onOpenTool: (tool: GeneralWorkspaceTool) => void;
  onOpenFile: (pane: Extract<GeneralPane, { kind: "app" }>, newBoard: boolean) => void;
  onReady: (term: Terminal, send: (data: string) => void, sessionName: string) => void;
  onDestroy: () => void;
  onStart: () => void;
  onRetryProject?: () => void;
}
export function GeneralWorkspacePane({
  pane,
  workspace,
  boardKey,
  active,
  visible,
  mobile,
  layoutSignal,
  dragHandleListeners,
  onActivate,
  onClose,
  onCycleWidth,
  onOpenTool,
  onOpenFile,
  onReady,
  onDestroy,
  onStart,
  onRetryProject,
}: Props) {
  const appFrame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    // Cross-origin iframe clicks move focus out of this document. Hover alone must
    // not steal the selected window when a launcher closes or tiles rearrange.
    let frame = 0;
    const activateFocusedApp = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (appFrame.current && document.activeElement === appFrame.current) onActivate();
      });
    };
    window.addEventListener("blur", activateFocusedApp);
    return () => {
      window.removeEventListener("blur", activateFocusedApp);
      cancelAnimationFrame(frame);
    };
  }, [onActivate]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [retry, setRetry] = useState(0);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const fileRequestGeneration = useRef(0);
  // A closed or reconnected source pane must not open a late file response.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Connection changes invalidate in-flight file requests.
  useEffect(
    () => () => {
      fileRequestGeneration.current++;
    },
    [connection],
  );
  const preparingProject = pane.kind === "project-launch";
  const projectLogs = pane.kind === "terminal" ? pane.projectLogs : undefined;
  const running = workspace?.latest_build.status === "running";
  const cloneSessionKey = pane.kind === "terminal" ? pane.cloneSessionKey : undefined;
  const relativePath = pane.kind === "terminal" ? pane.relativePath : undefined;
  const sessionName = pane.kind === "terminal" ? pane.sessionName : undefined;
  const file = pane.kind === "app" ? pane.file : undefined;
  const projectPath = pane.kind === "app" ? pane.projectPath : undefined;
  const tool = pane.kind === "app" ? pane.tool : undefined;
  const agentQuery = useDiscovery(
    "agent",
    { workspaceId: pane.workspaceId, buildId: workspace?.latest_build.id },
    { enabled: running && pane.kind === "terminal" },
  );
  // Disabled queries still observe shared cache updates. App frames must not reconnect
  // when a terminal or another consumer discovers or refreshes this workspace's agent.
  const agentId = pane.kind === "terminal" ? agentQuery.data?.agentId : undefined;
  const agentStatus = pane.kind === "terminal" ? agentQuery.data?.agentStatus : undefined;
  const agentPending = pane.kind === "terminal" && agentQuery.isPending;
  const agentError =
    pane.kind === "terminal" && !agentQuery.data ? agentQuery.error?.message : undefined;
  const refreshClone = useCallback(async () => {
    if (!cloneSessionKey || !relativePath) throw new Error("Repository terminal is unavailable.");
    const result = await resolveGitCloneTerminalAction({
      workspaceId: pane.workspaceId,
      cloneSessionKey,
      relativePath,
    });
    if (!result?.data)
      throw new Error(result?.serverError ?? "Could not reconnect to this repository terminal.");
    return result.data;
  }, [pane.workspaceId, cloneSessionKey, relativePath]);
  // A new Coder build or explicit retry requires fresh agent/app credentials.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Build and retry are explicit invalidation signals.
  useEffect(() => {
    if (preparingProject || !running || agentPending) return;
    let cancelled = false;
    setConnection(null);
    async function connect() {
      if (file) {
        const result = await getWorkspaceSessionToolsAction({
          workspaceId: pane.workspaceId,
          sessionName: file.sessionName,
          filePath: file.path,
          tool: "files",
          documentFrameHosts: readDocumentCoderFrameHosts(),
        });
        if (!result?.data?.folderPath)
          throw new Error(
            result?.serverError ?? "Could not resolve this file inside the File Browser root.",
          );
        return { url: result.data.filesUrl, reloadRequired: result.data.reloadRequired };
      }
      if (tool) {
        const result = await getWorkspaceAppToolAction({
          workspaceId: pane.workspaceId,
          tool: tool === "files" ? "filebrowser" : tool === "desktop" ? "kasmvnc" : "code",
          ...(projectPath ? { projectPath } : {}),
          documentFrameHosts: readDocumentCoderFrameHosts(),
        });
        if (!result?.data)
          throw new Error(result?.serverError ?? "Could not open this workspace app.");
        return result.data;
      }
      if (!agentId || agentStatus !== "connected")
        throw new Error(agentError ?? "The workspace agent is not connected yet.");
      const identity = cloneSessionKey ? await refreshClone() : { sessionName };
      return { agentId, ...identity };
    }
    void connect()
      .then((data) => {
        if (!cancelled) setConnection(data);
      })
      .catch((error) => {
        if (!cancelled)
          setConnection({ error: error instanceof Error ? error.message : "Could not connect." });
      });
    return () => {
      cancelled = true;
    };
  }, [
    preparingProject,
    running,
    agentId,
    agentStatus,
    agentPending,
    agentError,
    workspace?.latest_build.id,
    pane.workspaceId,
    tool,
    projectPath,
    file,
    sessionName,
    cloneSessionKey,
    refreshClone,
    retry,
  ]);
  const reconnect = () => {
    if (pane.kind === "terminal") {
      forgetTerminalViews(pane.workspaceId, [terminalPaneViewKey(boardKey, pane.id)]);
      void agentQuery.refresh().catch(() => {});
    }
    setConnection(null);
    setRetry((value) => value + 1);
  };
  const openFile = async (path: string, action: "download" | "open" | "new-workspace") => {
    if (!connection?.sessionName) return;
    const generation = fileRequestGeneration.current;
    // Reserve the download window during the gesture, before Coder authorization.
    const download = action === "download" ? window.open("about:blank", "_blank") : null;
    if (action === "download" && !download) {
      toast.error("Allow pop-ups to download this file.");
      return;
    }
    if (download) download.opener = null;
    try {
      const result = await getWorkspaceSessionToolsAction({
        workspaceId: pane.workspaceId,
        sessionName: connection.sessionName,
        fallbackPath: connection.clonePath,
        filePath: path,
        download: action === "download",
        tool: "files",
        documentFrameHosts: readDocumentCoderFrameHosts(),
      });
      if (fileRequestGeneration.current !== generation) {
        download?.close();
        return;
      }
      if (!result?.data?.folderPath)
        throw new Error(
          result?.serverError ?? "Could not resolve this file inside the File Browser root.",
        );
      if (download) {
        download.location.replace(result.data.filesUrl);
      } else {
        // Freeze the target before saving it: relative links depend on the terminal's current cwd.
        onOpenFile(
          {
            kind: "app",
            workspaceId: pane.workspaceId,
            tool: "files",
            label: "Files",
            file: { sessionName: connection.sessionName, path: result.data.folderPath },
          },
          action === "new-workspace",
        );
      }
    } catch (error) {
      download?.close();
      if (fileRequestGeneration.current === generation)
        toast.error(error instanceof Error ? error.message : "Could not open this file.");
    }
  };
  const capabilities = workspaceTemplateCapabilities(workspace?.template_name ?? "");
  const actions: WorkspacePaneAction[] = [
    {
      id: "workspace",
      label: "Open workspace details",
      icon: "activate",
      onSelect: () =>
        requestHiveWindow({ tool: "workspace-details", workspaceId: pane.workspaceId }),
    },
    ...(pane.kind === "terminal"
      ? [
          {
            id: "logs",
            icon: "logs" as const,
            label: "Session logs",
            onSelect: () =>
              requestHiveWindow({
                tool: "logs",
                workspaceId: pane.workspaceId,
                sessionName: connection?.sessionName,
              }),
          },
        ]
      : []),
    ...(pane.kind === "terminal" && capabilities.desktop
      ? [
          {
            id: "desktop",
            icon: "activate" as const,
            label: "Open Desktop",
            onSelect: () => onOpenTool("desktop"),
          },
        ]
      : []),
    ...(pane.kind === "terminal" && capabilities.fileBrowser
      ? [
          {
            id: "files",
            icon: "files" as const,
            label: "Open files",
            onSelect: () => onOpenTool("files"),
          },
        ]
      : []),
    ...(pane.kind === "terminal" && capabilities.editor
      ? [
          {
            id: "code",
            icon: "code" as const,
            label: "Open VS Code",
            onSelect: () => onOpenTool("code"),
          },
        ]
      : []),
    ...(!preparingProject
      ? [{ id: "retry", icon: "activate" as const, label: "Reconnect", onSelect: reconnect }]
      : []),
    {
      id: "remove",
      icon: "remove",
      label: "Close window",
      description: pane.kind === "terminal" ? "Keep the terminal session running" : undefined,
      onSelect: onClose,
    },
  ];
  let content: ReactNode;
  if (pane.kind === "project-launch") {
    content = (
      <ProjectLaunchFeedback logs={pane.logs} error={pane.error} onRetry={onRetryProject} />
    );
  } else if (!workspace) {
    content = <p>This Coder workspace is unavailable.</p>;
  } else if (!running) {
    content = (
      <>
        <p>
          {workspace.name} is {workspace.latest_build.status}.
        </p>
        {workspace.latest_build.status === "stopped" ? (
          <Button onClick={onStart}>Start workspace</Button>
        ) : null}
      </>
    );
  } else if (connection?.error) {
    content = projectLogs ? (
      <ProjectLaunchFeedback logs={projectLogs} error={connection.error} onRetry={reconnect} />
    ) : (
      <>
        <p role="alert">{connection.error}</p>
        <Button onClick={reconnect}>Retry connection</Button>
      </>
    );
  } else if (connection?.reloadRequired) {
    content = (
      <>
        <p>Reload Hive to connect this workspace app.</p>
        <Button onClick={() => window.location.reload()}>Reload Hive</Button>
      </>
    );
  } else if (pane.kind === "app" && connection?.url) {
    content = (
      <iframe
        ref={appFrame}
        src={connection.url}
        title={`${pane.label} · ${workspace.name}`}
        className="h-full w-full border-0"
        allow={WORKSPACE_APP_FRAME_ALLOW}
        sandbox={WORKSPACE_APP_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        onFocus={onActivate}
        data-testid={`general-app-${pane.tool}`}
      />
    );
  } else if (pane.kind === "terminal" && connection?.agentId && connection.sessionName) {
    content = (
      <InteractiveTerminal
        key={retry}
        agentId={connection.agentId}
        workspaceId={pane.workspaceId}
        sessionName={connection.sessionName}
        viewKey={terminalPaneViewKey(boardKey, pane.id)}
        clonePath={connection.clonePath}
        cloneProof={connection.cloneProof}
        refreshCloneTerminalIdentity={cloneSessionKey ? refreshClone : undefined}
        className="h-full rounded-none border-0"
        onTerminalReady={(term, send) =>
          onReady(term, send, connection.sessionName ?? pane.sessionName)
        }
        onTerminalDestroy={onDestroy}
        onFileAction={capabilities.fileBrowser ? openFile : undefined}
        onUserFocusRequest={onActivate}
        targetLabel={`${workspace.name} · ${pane.label}`}
        layoutSignal={`${layoutSignal}:${visible}`}
        suppressAutoFocus={!active || !visible}
        mobileInputMode={mobile}
        pinToBottomOnResize={mobile}
      />
    );
  } else {
    content = projectLogs ? (
      <ProjectLaunchFeedback logs={projectLogs} />
    ) : (
      <LoadingStatus>Connecting to {workspace.name}…</LoadingStatus>
    );
  }
  const connected =
    running &&
    !connection?.error &&
    !connection?.reloadRequired &&
    (connection?.url || connection?.agentId);
  return (
    <>
      <TerminalSessionFrame
        label={pane.label}
        subtitle={`${workspace?.name ?? pane.workspaceId}${relativePath || projectPath ? ` · ${relativePath ?? projectPath}` : ""}`}
        active={active && visible}
        className="h-full"
        layoutMode="tiled"
        dragHandleListeners={dragHandleListeners}
        onActivate={onActivate}
        onFocusActivate
        onClose={onClose}
        onCycleWidth={onCycleWidth}
        closeLabel={`Close ${pane.label} window`}
        onOpenActions={setAnchor}
        actionsOpen={!!anchor}
        touchOptimizedActions={mobile}
        dataTestId={`general-window-${pane.id}`}
      >
        <div
          className={
            connected
              ? "h-full min-h-0"
              : "flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm"
          }
        >
          <Suspense
            fallback={
              projectLogs ? (
                <div className="flex h-full items-center justify-center p-4">
                  <ProjectLaunchFeedback logs={projectLogs} />
                </div>
              ) : (
                <LoadingStatus placement="window">Loading terminal…</LoadingStatus>
              )
            }
          >
            {content}
          </Suspense>
        </div>
      </TerminalSessionFrame>
      <WorkspacePaneActionSheet
        actions={actions}
        anchor={anchor}
        label={pane.label}
        description={workspace?.name}
        open={!!anchor}
        onOpenChange={(open) => {
          if (!open) setAnchor(null);
        }}
        fontSizeScope={
          pane.kind === "terminal" && connection?.sessionName
            ? terminalFontSizeScope(pane.workspaceId, connection.sessionName)
            : undefined
        }
      />
    </>
  );
}
