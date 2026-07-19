"use client";

import { Code2, FolderOpen, Loader2 } from "lucide-react";
import { type Dispatch, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getWorkspaceSessionToolsAction } from "@/lib/actions/workspaces";

export type WorkspaceTool = "code" | "files";

export interface WorkspaceSessionToolUrls {
  codeUrl: string;
  filesUrl: string;
  folderPath: string | null;
}

export interface WorkspaceToolOpenRequest {
  tool: WorkspaceTool;
  urls: WorkspaceSessionToolUrls;
}

interface WorkspaceSessionToolsProps {
  workspaceId: string;
  sessionName: string;
  label: string;
  fallbackPath?: string;
  onOpenTool: Dispatch<WorkspaceToolOpenRequest>;
}

export function isWorkspaceSessionToolUrls(value: unknown): value is WorkspaceSessionToolUrls {
  if (typeof value !== "object" || value === null) return false;
  const properties = Object.fromEntries(Object.entries(value));
  return (
    typeof properties.codeUrl === "string" &&
    properties.codeUrl.length > 0 &&
    typeof properties.filesUrl === "string" &&
    properties.filesUrl.length > 0 &&
    (properties.folderPath === null || typeof properties.folderPath === "string")
  );
}

export function WorkspaceSessionTools({
  workspaceId,
  sessionName,
  label,
  fallbackPath,
  onOpenTool,
}: WorkspaceSessionToolsProps) {
  const [loadingTool, setLoadingTool] = useState<WorkspaceTool | null>(null);

  async function openTool(tool: WorkspaceTool) {
    setLoadingTool(tool);
    try {
      const result = await getWorkspaceSessionToolsAction({
        workspaceId,
        sessionName,
        fallbackPath,
        tool,
      });
      if (!isWorkspaceSessionToolUrls(result?.data)) {
        toast.error("Could not open workspace tools for this session.");
        return;
      }
      onOpenTool({ tool, urls: result.data });
    } catch {
      toast.error("Could not open workspace tools for this session.");
    } finally {
      setLoadingTool(null);
    }
  }

  return (
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
