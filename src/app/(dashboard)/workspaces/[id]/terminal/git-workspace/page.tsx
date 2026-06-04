import { MultiSessionWorkspace } from "@/components/workspaces/MultiSessionWorkspace";
import { getWorkspaceAgentAction } from "@/lib/actions/workspaces";
import { StaleEntryAlert } from "../stale-entry-alert";

interface GitWorkspaceTerminalPageProps {
  params: Promise<{ id: string }>;
}

const WORKSPACE_TERMINAL_SHELL_CLASS_NAME =
  "-mx-6 h-[calc(var(--app-viewport-height)-var(--safe-area-inset-top)-3.5rem)] min-h-0 w-[calc(100%+3rem)] overflow-hidden md:h-[calc(var(--app-viewport-height)-var(--safe-area-inset-top)-var(--safe-area-inset-bottom)-5rem)]";

export default async function GitWorkspaceTerminalPage({ params }: GitWorkspaceTerminalPageProps) {
  const { id: workspaceId } = await params;
  const agentResult = await getWorkspaceAgentAction({ workspaceId });

  if (!agentResult?.data) {
    return <StaleEntryAlert workspaceId={workspaceId} />;
  }

  return (
    <MultiSessionWorkspace
      agentId={agentResult.data.agentId}
      workspaceId={workspaceId}
      source="git"
      className={WORKSPACE_TERMINAL_SHELL_CLASS_NAME}
    />
  );
}
