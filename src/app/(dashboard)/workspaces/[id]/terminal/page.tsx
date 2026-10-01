import { getWorkspaceAgentAction } from "@/lib/actions/workspaces";
import { StaleEntryAlert } from "./stale-entry-alert";
import { TerminalClient } from "./terminal-client";

interface TerminalPageProps {
  params: Promise<{ id: string }>;
}

export default async function TerminalPage({ params }: TerminalPageProps) {
  const { id: workspaceId } = await params;

  const agentResult = await getWorkspaceAgentAction({ workspaceId });

  if (!agentResult?.data) {
    return <StaleEntryAlert workspaceId={workspaceId} />;
  }

  if (agentResult.data.agentStatus && agentResult.data.agentStatus !== "connected") {
    return <StaleEntryAlert workspaceId={workspaceId} agentStatus={agentResult.data.agentStatus} />;
  }

  return (
    <div className="h-full min-h-0 w-full overflow-hidden" data-dashboard-full-bleed="">
      <TerminalClient
        agentId={agentResult.data.agentId}
        agentName={agentResult.data.agentName}
        workspaceId={workspaceId}
      />
    </div>
  );
}
