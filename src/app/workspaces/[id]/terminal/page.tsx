import { getWorkspaceAgentAction, getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import { TerminalClient } from "./terminal-client";

interface TerminalPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ session?: string }>;
}

export default async function TerminalPage({ params, searchParams }: TerminalPageProps) {
  const { id: workspaceId } = await params;
  const { session } = await searchParams;

  const [agentResult, sessionsResult] = await Promise.all([
    getWorkspaceAgentAction({ workspaceId }),
    getWorkspaceSessionsAction({ workspaceId }),
  ]);

  if (!agentResult?.data) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <div className="text-center">
          <h1 className="text-xl font-semibold">No agent found</h1>
          <p className="mt-2 text-muted-foreground">
            Could not find a running agent for this workspace.
          </p>
        </div>
      </div>
    );
  }

  const coderUrl = process.env.CODER_URL ?? "";
  const sessions = sessionsResult?.data ?? [];

  return (
    <TerminalClient
      agentId={agentResult.data.agentId}
      coderUrl={coderUrl}
      workspaceId={workspaceId}
      initialSessions={sessions}
      initialSessionName={session}
    />
  );
}
