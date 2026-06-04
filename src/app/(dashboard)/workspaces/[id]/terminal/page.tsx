import { getTerminalSettingsAction } from "@/lib/actions/user-settings";
import {
  terminalSettingsDtoSchema,
  type TerminalSettingsDto,
} from "@/lib/actions/user-settings-contract";
import { getWorkspaceAgentAction } from "@/lib/actions/workspaces";
import { StaleEntryAlert } from "./stale-entry-alert";
import { TerminalClient } from "./terminal-client";

interface TerminalPageProps {
  params: Promise<{ id: string }>;
}

function isTerminalSettingsDto(value: unknown): value is TerminalSettingsDto {
  return terminalSettingsDtoSchema.safeParse(value).success;
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
    <TerminalClient
      agentId={agentResult.data.agentId}
      agentName={agentResult.data.agentName}
      terminalControlsBeyondMobile={terminalControlsBeyondMobile}
      workspaceId={workspaceId}
    />
  );
}
