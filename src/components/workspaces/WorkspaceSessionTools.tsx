"use client";

import { Code2, FolderOpen, Loader2, ScrollText } from "lucide-react";
import { type Dispatch, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getWorkspaceSessionToolsAction } from "@/lib/actions/workspaces";
import { readDocumentCoderFrameHosts } from "@/lib/workspaces/document-frame-hosts";

export type WorkspaceTool = "code" | "files";

export interface WorkspaceSessionToolUrls {
  codeUrl: string;
  filesUrl: string;
  folderPath: string | null;
  reloadRequired?: boolean;
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
  onOpenLogs?: () => void;
}

export function isWorkspaceSessionToolUrls(value: unknown): value is WorkspaceSessionToolUrls {
  if (typeof value !== "object" || value === null) return false;
  const properties = Object.fromEntries(Object.entries(value));
  return (
    typeof properties.codeUrl === "string" &&
    properties.codeUrl.length > 0 &&
    typeof properties.filesUrl === "string" &&
    properties.filesUrl.length > 0 &&
    (properties.folderPath === null || typeof properties.folderPath === "string") &&
    (properties.reloadRequired === undefined || typeof properties.reloadRequired === "boolean")
  );
}

export function WorkspaceSessionTools({
  workspaceId,
  sessionName,
  label,
  fallbackPath,
  onOpenTool,
  onOpenLogs,
}: WorkspaceSessionToolsProps) {
  const [loadingTools, setLoadingTools] = useState<Set<WorkspaceTool>>(() => new Set());
  const latestWorkspaceIdRef = useRef(workspaceId);
  const requestIdsRef = useRef({ code: 0, files: 0 });
  latestWorkspaceIdRef.current = workspaceId;

  useEffect(() => {
    latestWorkspaceIdRef.current = workspaceId;
    requestIdsRef.current.code += 1;
    requestIdsRef.current.files += 1;
    setLoadingTools(new Set());
    return () => {
      requestIdsRef.current.code += 1;
      requestIdsRef.current.files += 1;
    };
  }, [workspaceId]);

  async function openTool(tool: WorkspaceTool) {
    const requestWorkspaceId = workspaceId;
    const requestId = ++requestIdsRef.current[tool];
    const isCurrentRequest = () =>
      latestWorkspaceIdRef.current === requestWorkspaceId &&
      requestIdsRef.current[tool] === requestId;
    setLoadingTools((current) => new Set(current).add(tool));
    try {
      const result = await getWorkspaceSessionToolsAction({
        workspaceId,
        sessionName,
        fallbackPath,
        documentFrameHosts: readDocumentCoderFrameHosts(),
        tool,
      });
      if (!isWorkspaceSessionToolUrls(result?.data)) {
        if (isCurrentRequest()) {
          toast.error("Could not open workspace tools for this session.");
        }
        return;
      }
      if (!isCurrentRequest()) return;
      onOpenTool({ tool, urls: result.data });
    } catch {
      if (isCurrentRequest()) {
        toast.error("Could not open workspace tools for this session.");
      }
    } finally {
      if (isCurrentRequest()) {
        setLoadingTools((current) => {
          const next = new Set(current);
          next.delete(tool);
          return next;
        });
      }
    }
  }

  return (
    <div className="flex items-center gap-0.5" data-testid={`workspace-tools-${sessionName}`}>
      <ToolButton
        tool="files"
        label={`Browse files for ${label}`}
        loading={loadingTools.has("files")}
        onClick={() => void openTool("files")}
      />
      <ToolButton
        tool="code"
        label={`Open VS Code for ${label}`}
        loading={loadingTools.has("code")}
        onClick={() => void openTool("code")}
      />
      {onOpenLogs ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 min-h-0 px-1.5 text-[10px] text-white/80 hover:bg-white/10 hover:text-white"
          aria-label={`Open session logs for ${label}`}
          title="Session logs"
          data-testid="open-logs"
          onClick={(event) => {
            event.stopPropagation();
            onOpenLogs();
          }}
        >
          <ScrollText className="size-3" />
          <span className="sr-only">Session logs</span>
        </Button>
      ) : null}
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
