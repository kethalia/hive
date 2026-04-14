"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { CoderWorkspace } from "@/lib/coder/types";
import { buildWorkspaceUrls } from "@/lib/workspaces/urls";
import { Button, buttonVariants } from "@/components/ui/button";
import { ExternalLink, FolderOpen, Monitor, LayoutDashboard } from "lucide-react";

type ActiveTab = "filebrowser" | "kasmvnc";

interface WorkspaceToolPanelProps {
  workspace: CoderWorkspace;
  agentName: string;
  coderUrl: string;
}

export function WorkspaceToolPanel({
  workspace,
  agentName,
  coderUrl,
}: WorkspaceToolPanelProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("filebrowser");
  const [iframeError, setIframeError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const urls = buildWorkspaceUrls(workspace, agentName, coderUrl);
  const activeUrl = activeTab === "filebrowser" ? urls.filebrowser : urls.kasmvnc;
  const isRunning = workspace.latest_build.status === "running";

  const handleTabSwitch = useCallback((tab: ActiveTab) => {
    setActiveTab(tab);
    setIframeError(false);
  }, []);

  useEffect(() => {
    if (!isRunning || iframeError) return;

    const timer = setTimeout(() => {
      try {
        const iframe = iframeRef.current;
        if (iframe) {
          // Accessing cross-origin contentWindow properties throws
          void iframe.contentWindow?.location.href;
        }
      } catch {
        setIframeError(true);
      }
    }, 4000);

    return () => clearTimeout(timer);
  }, [activeUrl, isRunning, iframeError]);

  if (!isRunning) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-border bg-muted/30 p-8">
        <p className="text-sm text-muted-foreground">
          Workspace must be running to use embedded tools. Current status:{" "}
          <span className="font-medium text-foreground">
            {workspace.latest_build.status}
          </span>
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled>
            <FolderOpen data-icon="inline-start" />
            Filebrowser
          </Button>
          <Button variant="outline" size="sm" disabled>
            <Monitor data-icon="inline-start" />
            KasmVNC
          </Button>
          <a
            href={urls.dashboard}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <LayoutDashboard data-icon="inline-start" />
            Coder Dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant={activeTab === "filebrowser" ? "default" : "outline"}
          size="sm"
          onClick={() => handleTabSwitch("filebrowser")}
        >
          <FolderOpen data-icon="inline-start" />
          Filebrowser
        </Button>
        <Button
          variant={activeTab === "kasmvnc" ? "default" : "outline"}
          size="sm"
          onClick={() => handleTabSwitch("kasmvnc")}
        >
          <Monitor data-icon="inline-start" />
          KasmVNC
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.open(activeUrl, "_blank")}
          >
            <ExternalLink data-icon="inline-start" />
            Pop Out
          </Button>
          <a
            href={urls.dashboard}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <LayoutDashboard data-icon="inline-start" />
            Dashboard
          </a>
        </div>
      </div>

      {iframeError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-lg border border-border bg-muted/30 p-8">
          <p className="text-sm text-muted-foreground">
            Unable to embed {activeTab === "filebrowser" ? "Filebrowser" : "KasmVNC"} in an iframe.
            Use the direct links below instead.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(urls.filebrowser, "_blank")}
            >
              <FolderOpen data-icon="inline-start" />
              Open Filebrowser
              <ExternalLink data-icon="inline-end" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(urls.kasmvnc, "_blank")}
            >
              <Monitor data-icon="inline-start" />
              Open KasmVNC
              <ExternalLink data-icon="inline-end" />
            </Button>
          </div>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          key={activeUrl}
          src={activeUrl}
          className="flex-1 rounded-lg border border-border"
          onError={() => setIframeError(true)}
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
        />
      )}
    </div>
  );
}
