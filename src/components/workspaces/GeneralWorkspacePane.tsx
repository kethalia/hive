"use client";

import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import type { Terminal } from "@xterm/xterm";
import dynamic from "next/dynamic";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TerminalSessionFrame } from "@/components/workspaces/TerminalSessionFrame";
import {
  type WorkspacePaneAction,
  WorkspacePaneActionSheet,
} from "@/components/workspaces/WorkspacePaneActionSheet";
import { resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import { getWorkspaceAgentAction, getWorkspaceAppToolAction } from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import {
  WORKSPACE_APP_FRAME_ALLOW,
  WORKSPACE_APP_FRAME_SANDBOX,
} from "@/lib/security/workspace-app-isolation";
import { workspaceTemplateCapabilities } from "@/lib/templates/catalog";
import { terminalFontSizeScope } from "@/lib/terminal/font-size";
import { terminalPaneViewKey } from "@/lib/terminal/session-lifetime";
import { readDocumentCoderFrameHosts } from "@/lib/workspaces/document-frame-hosts";
import type { GeneralWindow, GeneralWorkspaceTool } from "@/lib/workspaces/general-workspace";

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
interface Props {
  pane: GeneralWindow;
  workspace?: CoderWorkspace;
  boardKey: string;
  active: boolean;
  visible: boolean;
  mobile: boolean;
  layoutSignal: string;
  dragHandleListeners?: DraggableSyntheticListeners;
  onActivate: () => void;
  onClose: () => void;
  onOpenTool: (tool: GeneralWorkspaceTool) => void;
  onReady: (term: Terminal, send: (data: string) => void, sessionName: string) => void;
  onDestroy: () => void;
  onStart: () => void;
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
  onOpenTool,
  onReady,
  onDestroy,
  onStart,
}: Props) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [retry, setRetry] = useState(0);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const running = workspace?.latest_build.status === "running";
  const cloneSessionKey = pane.kind === "terminal" ? pane.cloneSessionKey : undefined;
  const relativePath = pane.kind === "terminal" ? pane.relativePath : undefined;
  const sessionName = pane.kind === "terminal" ? pane.sessionName : undefined;
  const tool = pane.kind === "app" ? pane.tool : undefined;
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
    if (!running) return;
    let cancelled = false;
    setConnection(null);
    async function connect() {
      if (tool) {
        const result = await getWorkspaceAppToolAction({
          workspaceId: pane.workspaceId,
          tool: tool === "files" ? "filebrowser" : tool === "desktop" ? "kasmvnc" : "code",
          documentFrameHosts: readDocumentCoderFrameHosts(),
        });
        if (!result?.data)
          throw new Error(result?.serverError ?? "Could not open this workspace app.");
        return result.data;
      }
      const result = await getWorkspaceAgentAction({ workspaceId: pane.workspaceId });
      if (!result?.data || result.data.agentStatus !== "connected")
        throw new Error(result?.serverError ?? "The workspace agent is not connected yet.");
      const identity = cloneSessionKey ? await refreshClone() : { sessionName };
      return { agentId: result.data.agentId, ...identity };
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
    running,
    workspace?.latest_build.id,
    pane.workspaceId,
    tool,
    sessionName,
    cloneSessionKey,
    refreshClone,
    retry,
  ]);
  const capabilities = workspaceTemplateCapabilities(workspace?.template_name ?? "");
  const actions: WorkspacePaneAction[] = [
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
    {
      id: "retry",
      icon: "activate",
      label: "Reconnect",
      onSelect: () => setRetry((value) => value + 1),
    },
    {
      id: "remove",
      icon: "remove",
      label: "Close window",
      description: pane.kind === "terminal" ? "Keep the terminal session running" : undefined,
      onSelect: onClose,
    },
  ];
  let content: ReactNode;
  if (!workspace) {
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
    content = (
      <>
        <p role="alert">{connection.error}</p>
        <Button onClick={() => setRetry((value) => value + 1)}>Retry connection</Button>
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
        src={connection.url}
        title={`${pane.label} · ${workspace.name}`}
        className="h-full w-full border-0"
        allow={WORKSPACE_APP_FRAME_ALLOW}
        sandbox={WORKSPACE_APP_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        onPointerEnter={onActivate}
        onFocus={onActivate}
        data-testid={`general-app-${pane.tool}`}
      />
    );
  } else if (pane.kind === "terminal" && connection?.agentId && connection.sessionName) {
    content = (
      <InteractiveTerminal
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
        onUserFocusRequest={onActivate}
        targetLabel={`${workspace.name} · ${pane.label}`}
        layoutSignal={`${layoutSignal}:${visible}`}
        suppressAutoFocus={!active || !visible}
        mobileInputMode={mobile}
        pinToBottomOnResize={mobile}
      />
    );
  } else {
    content = <p role="status">Connecting to {workspace.name}…</p>;
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
        subtitle={`${workspace?.name ?? pane.workspaceId}${relativePath ? ` · ${relativePath}` : ""}`}
        active={active && visible}
        className="h-full"
        layoutMode="tiled"
        dragHandleListeners={dragHandleListeners}
        onActivate={onActivate}
        onFocusActivate
        onClose={onClose}
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
          {content}
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
