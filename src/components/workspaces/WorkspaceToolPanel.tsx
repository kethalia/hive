"use client";

import { useState, useRef, useEffect } from "react";
import type { CoderWorkspace } from "@/lib/coder/types";
import { buildWorkspaceUrls } from "@/lib/workspaces/urls";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ExternalLink, FolderOpen, Monitor, LayoutDashboard, AlertCircle } from "lucide-react";

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
  const [activeTab, setActiveTab] = useState("filebrowser");
  const [iframeError, setIframeError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const urls = buildWorkspaceUrls(workspace, agentName, coderUrl);
  const activeUrl = urls ? (activeTab === "filebrowser" ? urls.filebrowser : urls.kasmvnc) : null;
  const isRunning = workspace.latest_build.status === "running";

  useEffect(() => {
    if (!isRunning || iframeError || !activeUrl) return;

    const timer = setTimeout(() => {
      try {
        const iframe = iframeRef.current;
        if (iframe) {
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
      <Alert>
        <AlertCircle />
        <AlertDescription>
          Workspace must be running to use embedded tools. Current status:{" "}
          <span className="font-medium text-foreground">
            {workspace.latest_build.status}
          </span>
        </AlertDescription>
        {urls && (
          <div className="mt-3 flex gap-2">
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
        )}
      </Alert>
    );
  }

  return (
    <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); setIframeError(false); }} className="flex h-full flex-col">
      <div className="flex items-center gap-2">
        <TabsList>
          <TabsTrigger value="filebrowser">
            <FolderOpen data-icon="inline-start" />
            Filebrowser
          </TabsTrigger>
          <TabsTrigger value="kasmvnc">
            <Monitor data-icon="inline-start" />
            KasmVNC
          </TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center gap-2">
          {activeUrl && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(activeUrl, "_blank")}
            >
              <ExternalLink data-icon="inline-start" />
              Pop Out
            </Button>
          )}
          {urls && (
            <a
              href={urls.dashboard}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              <LayoutDashboard data-icon="inline-start" />
              Dashboard
            </a>
          )}
        </div>
      </div>

      {iframeError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-lg border border-border bg-muted/30 p-8">
          <Alert>
            <AlertCircle />
            <AlertDescription>
              Unable to embed {activeTab === "filebrowser" ? "Filebrowser" : "KasmVNC"} in an iframe.
              Use the direct links below instead.
            </AlertDescription>
          </Alert>
          {urls && (
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
          )}
        </div>
      ) : (
        <>
          <TabsContent value="filebrowser" className="flex-1">
            {urls && (
              <iframe
                ref={activeTab === "filebrowser" ? iframeRef : undefined}
                src={urls.filebrowser}
                className="h-full w-full rounded-lg border border-border"
                onError={() => setIframeError(true)}
                sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
              />
            )}
          </TabsContent>
          <TabsContent value="kasmvnc" className="flex-1">
            {urls && (
              <iframe
                ref={activeTab === "kasmvnc" ? iframeRef : undefined}
                src={urls.kasmvnc}
                className="h-full w-full rounded-lg border border-border"
                onError={() => setIframeError(true)}
                sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
              />
            )}
          </TabsContent>
        </>
      )}
    </Tabs>
  );
}
