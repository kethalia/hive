import { getWorkspaceAgentAction } from "@/lib/actions/workspaces";
import { TerminalClient } from "./terminal-client";
import { StaleEntryAlert } from "./stale-entry-alert";

interface TerminalPageProps {
  params: Promise<{ id: string }>;
}

export default async function TerminalPage({ params }: TerminalPageProps) {
  const { id: workspaceId } = await params;

  const agentResult = await getWorkspaceAgentAction({ workspaceId });

  if (!agentResult?.data) {
    return <StaleEntryAlert workspaceId={workspaceId} />;
  }

  return <TerminalClient agentId={agentResult.data.agentId} workspaceId={workspaceId} />;
}
