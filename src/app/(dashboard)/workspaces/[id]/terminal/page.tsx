import { getTerminalSettingsAction } from "@/lib/actions/user-settings";
import { isTerminalSettingsDto } from "@/lib/actions/user-settings-contract";
import { getWorkspaceAgentAction } from "@/lib/actions/workspaces";
import { StaleEntryAlert } from "./stale-entry-alert";
import { TerminalClient } from "./terminal-client";

interface TerminalPageProps {
  params: Promise<{ id: string }>;
}

async function getTerminalControlsBeyondMobile(): Promise<boolean> {
  try {
    const settingsResult = await getTerminalSettingsAction();
    return isTerminalSettingsDto(settingsResult?.data)
      ? settingsResult.data.terminalControlsBeyondMobile
      : false;
  } catch {
    return false;
  }
}

export default async function TerminalPage({ params }: TerminalPageProps) {
  const { id: workspaceId } = await params;

  const [agentResult, terminalControlsBeyondMobile] = await Promise.all([
    getWorkspaceAgentAction({ workspaceId }),
    getTerminalControlsBeyondMobile(),
  ]);

  if (!agentResult?.data) {
    return <StaleEntryAlert workspaceId={workspaceId} />;
  }

  return (
    <div className="h-full min-h-0 w-full overflow-hidden" data-dashboard-full-bleed="">
      <TerminalClient
        agentId={agentResult.data.agentId}
        agentName={agentResult.data.agentName}
        terminalControlsBeyondMobile={terminalControlsBeyondMobile}
        workspaceId={workspaceId}
      />
    </div>
  );
}
