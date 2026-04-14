import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  getWorkspaceAction,
  getWorkspaceAgentAction,
} from "@/lib/actions/workspaces";
import { WorkspaceToolPanel } from "@/components/workspaces/WorkspaceToolPanel";

interface WorkspaceDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function WorkspaceDetailPage({
  params,
}: WorkspaceDetailPageProps) {
  const { id: workspaceId } = await params;

  const [workspaceResult, agentResult] = await Promise.all([
    getWorkspaceAction({ workspaceId }),
    getWorkspaceAgentAction({ workspaceId }),
  ]);

  if (!workspaceResult?.data) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <div className="text-center">
          <h1 className="text-xl font-semibold">Workspace not found</h1>
          <p className="mt-2 text-muted-foreground">
            Could not load workspace data. It may have been deleted or you may
            not have access.
          </p>
          <Link
            href="/workspaces"
            className="mt-4 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to workspaces
          </Link>
        </div>
      </div>
    );
  }

  const agentName = agentResult?.data?.agentName ?? "main";
  const coderUrl = process.env.CODER_URL ?? "";

  return (
    <div className="flex h-screen flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <Link
          href="/workspaces"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Workspaces
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-lg font-semibold">{workspaceResult.data.name}</h1>
      </div>

      <WorkspaceToolPanel
        workspace={workspaceResult.data}
        agentName={agentName}
        coderUrl={coderUrl}
      />
    </div>
  );
}
