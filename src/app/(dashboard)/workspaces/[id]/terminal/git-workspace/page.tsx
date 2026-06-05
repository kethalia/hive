import { MultiSessionWorkspace } from "@/components/workspaces/MultiSessionWorkspace";
import { getWorkspaceAgentAction } from "@/lib/actions/workspaces";
import { StaleEntryAlert } from "../stale-entry-alert";

interface GitWorkspaceTerminalPageProps {
  params: Promise<{ id: string }>;
}

const WORKSPACE_TERMINAL_SHELL_CLASS_NAME = "h-full min-h-0 w-full overflow-hidden";

export default async function GitWorkspaceTerminalPage({ params }: GitWorkspaceTerminalPageProps) {
  const { id: workspaceId } = await params;
  const agentResult = await getWorkspaceAgentAction({ workspaceId });

  if (!agentResult?.data) {
    return <StaleEntryAlert workspaceId={workspaceId} />;
  }

  return (
    <div className="h-full min-h-0 w-full overflow-hidden" data-dashboard-full-bleed="">
      <MultiSessionWorkspace
        agentId={agentResult.data.agentId}
        workspaceId={workspaceId}
        source="unified"
        className={WORKSPACE_TERMINAL_SHELL_CLASS_NAME}
      />
    </div>
  );
}
