import { getWorkspaceAgentAction, getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import { TerminalClient } from "./terminal-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

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
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle />
          <AlertDescription>
            Could not find a running agent for this workspace.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const sessions = sessionsResult?.data ?? [];

  return (
    <TerminalClient
      agentId={agentResult.data.agentId}
      workspaceId={workspaceId}
      initialSessions={sessions}
      initialSessionName={session}
    />
  );
}
