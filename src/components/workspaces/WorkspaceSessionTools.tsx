"use client";

import { Code2, ExternalLink, FolderOpen, Loader2 } from "lucide-react";
import { type Dispatch, type SetStateAction, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getWorkspaceSessionToolsAction } from "@/lib/actions/workspaces";
import { openWorkspaceToolPopup } from "@/lib/workspaces/embedded-tools";

type WorkspaceTool = "code" | "files";
type ActiveToolChangeHandler = Dispatch<SetStateAction<WorkspaceTool | null>>;

interface WorkspaceSessionToolsProps {
  workspaceId: string;
  sessionName: string;
  label: string;
  fallbackPath?: string;
}

interface WorkspaceSessionToolUrls {
  codeUrl: string;
  filesUrl: string;
  folderPath: string | null;
}

function isWorkspaceSessionToolUrls(value: unknown): value is WorkspaceSessionToolUrls {
  if (typeof value !== "object" || value === null) return false;
  return (
    hasNonEmptyString(value, "codeUrl") &&
    hasNonEmptyString(value, "filesUrl") &&
    hasFolderPath(value)
  );
}

function hasNonEmptyString(value: object, key: string): boolean {
  const property = Object.entries(value).find(([propertyKey]) => propertyKey === key)?.[1];
  return typeof property === "string" && property.length > 0;
}

function hasFolderPath(value: object): boolean {
  return (
    "folderPath" in value && (value.folderPath === null || typeof value.folderPath === "string")
  );
}

export function WorkspaceSessionTools({
  workspaceId,
  sessionName,
  label,
  fallbackPath,
}: WorkspaceSessionToolsProps) {
  const [activeTool, setActiveTool] = useState<WorkspaceTool | null>(null);
  const [loadingTool, setLoadingTool] = useState<WorkspaceTool | null>(null);
  const [urls, setUrls] = useState<WorkspaceSessionToolUrls | null>(null);

  async function openTool(tool: WorkspaceTool) {
    setLoadingTool(tool);
    try {
      const result = await getWorkspaceSessionToolsAction({
        workspaceId,
        sessionName,
        fallbackPath,
      });
      if (!isWorkspaceSessionToolUrls(result?.data)) {
        toast.error("Could not open workspace tools for this session.");
        return;
      }
      setUrls(result.data);
      setActiveTool(tool);
    } catch {
      toast.error("Could not open workspace tools for this session.");
    } finally {
      setLoadingTool(null);
    }
  }

  return (
    <>
      <div className="flex items-center gap-0.5" data-testid={`workspace-tools-${sessionName}`}>
        <ToolButton
          tool="files"
          label={`Browse files for ${label}`}
          loading={loadingTool === "files"}
          onClick={() => void openTool("files")}
        />
        <ToolButton
          tool="code"
          label={`Open VS Code for ${label}`}
          loading={loadingTool === "code"}
          onClick={() => void openTool("code")}
        />
      </div>
      <WorkspaceToolDialog
        activeTool={activeTool}
        urls={urls}
        label={label}
        onActiveToolChange={setActiveTool}
      />
    </>
  );
}

function WorkspaceToolDialog({
  activeTool,
  urls,
  label,
  onActiveToolChange,
}: {
  activeTool: WorkspaceTool | null;
  urls: WorkspaceSessionToolUrls | null;
  label: string;
  onActiveToolChange: ActiveToolChangeHandler;
}) {
  const activeUrl = activeTool === "code" ? urls?.codeUrl : urls?.filesUrl;
  const title = activeTool === "code" ? "VS Code" : "Files";
  return (
    <Dialog
      open={activeTool !== null}
      onOpenChange={(open) => {
        if (!open) onActiveToolChange(null);
      }}
    >
      {activeTool && urls && activeUrl ? (
        <DialogContent
          className="grid h-[min(92dvh,1000px)] w-[min(98vw,1600px)] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-2 overflow-hidden p-2"
          data-testid="workspace-tool-dialog"
        >
          <WorkspaceToolHeader
            activeTool={activeTool}
            activeUrl={activeUrl}
            title={title}
            label={label}
            folderPath={urls.folderPath}
            onActiveToolChange={onActiveToolChange}
          />
          <iframe
            key={activeUrl}
            src={activeUrl}
            title={`${title} for ${label}`}
            className="h-full min-h-0 w-full rounded-md border border-border bg-background"
            allow="clipboard-read; clipboard-write"
            data-testid="workspace-tool-frame"
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function WorkspaceToolHeader({
  activeTool,
  activeUrl,
  title,
  label,
  folderPath,
  onActiveToolChange,
}: {
  activeTool: WorkspaceTool;
  activeUrl: string;
  title: string;
  label: string;
  folderPath: string | null;
  onActiveToolChange: ActiveToolChangeHandler;
}) {
  return (
    <DialogHeader className="flex-row items-center gap-2 pr-10 text-left">
      <div className="min-w-0 flex-1">
        <DialogTitle className="truncate text-sm">
          {title}: {label}
        </DialogTitle>
        <DialogDescription className="truncate font-mono text-xs">
          {folderPath ?? "/home/coder"}
        </DialogDescription>
      </div>
      <div className="flex items-center gap-1" role="tablist" aria-label="Workspace tools">
        <ToolTab tool="files" activeTool={activeTool} onActiveToolChange={onActiveToolChange} />
        <ToolTab tool="code" activeTool={activeTool} onActiveToolChange={onActiveToolChange} />
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => openWorkspaceToolPopup(activeUrl, activeTool)}
          aria-label={`Open ${title} in a new window`}
        >
          <ExternalLink className="size-3" /> Pop out
        </Button>
      </div>
    </DialogHeader>
  );
}

function ToolTab({
  tool,
  activeTool,
  onActiveToolChange,
}: {
  tool: WorkspaceTool;
  activeTool: WorkspaceTool;
  onActiveToolChange: ActiveToolChangeHandler;
}) {
  const isCode = tool === "code";
  return (
    <Button
      type="button"
      role="tab"
      size="xs"
      variant={activeTool === tool ? "secondary" : "ghost"}
      aria-selected={activeTool === tool}
      onClick={() => {
        onActiveToolChange(tool);
      }}
    >
      {isCode ? <Code2 className="size-3" /> : <FolderOpen className="size-3" />}
      {isCode ? "VS Code" : "Files"}
    </Button>
  );
}

function ToolButton({
  tool,
  label,
  loading,
  onClick,
}: {
  tool: WorkspaceTool;
  label: string;
  loading: boolean;
  onClick: () => void;
}) {
  const Icon = tool === "code" ? Code2 : FolderOpen;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-6 min-h-0 px-1.5 text-[10px] text-white/80 hover:bg-white/10 hover:text-white"
      aria-label={label}
      title={tool === "code" ? "VS Code" : "Files"}
      data-testid={`open-${tool}`}
      disabled={loading}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {loading ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
      <span className="sr-only">{tool === "code" ? "VS Code" : "Files"}</span>
    </Button>
  );
}
