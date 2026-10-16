import { NotificationTerminalLink } from "@/components/terminal/NotificationTerminalLink";
import { getWorkspaceAgentAction } from "@/lib/actions/workspaces";
import { isCloneTerminalSessionName } from "@/lib/git/clone-terminal-session";
import { StaleEntryAlert } from "./stale-entry-alert";
import { TerminalClient } from "./terminal-client";

interface TerminalQuery {
  session?: string | string[];
  cloneProof?: string | string[];
  notification?: string | string[];
}
interface TerminalPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<TerminalQuery>;
}

export default async function TerminalPage({ params, searchParams }: TerminalPageProps) {
  const [{ id: workspaceId }, query] = await Promise.all([
    params,
    searchParams ?? Promise.resolve<TerminalQuery>({}),
  ]);
  const agentResult = await getWorkspaceAgentAction({ workspaceId });

  if (!agentResult?.data) {
    return <StaleEntryAlert workspaceId={workspaceId} />;
  }

  if (agentResult.data.agentStatus && agentResult.data.agentStatus !== "connected") {
    return <StaleEntryAlert workspaceId={workspaceId} agentStatus={agentResult.data.agentStatus} />;
  }

  if (
    typeof query.session === "string" &&
    (query.notification || (isCloneTerminalSessionName(query.session) && !query.cloneProof))
  ) {
    return (
      <NotificationTerminalLink
        workspaceId={workspaceId}
        agentId={agentResult.data.agentId}
        sessionName={query.session}
      />
    );
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
