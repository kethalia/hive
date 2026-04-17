import { getWorkspaceAgentAction } from "@/lib/actions/workspaces";
import { TerminalClient } from "./terminal-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

interface TerminalPageProps {
  params: Promise<{ id: string }>;
}

export default async function TerminalPage({ params }: TerminalPageProps) {
  const { id: workspaceId } = await params;

  const agentResult = await getWorkspaceAgentAction({ workspaceId });

  if (!agentResult?.data) {
    return (
      <div className="-m-6 -mt-14 flex h-[100vh] w-[calc(100%+3rem)] items-center justify-center">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle />
          <AlertDescription>
            Could not find a running agent for this workspace.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return <TerminalClient agentId={agentResult.data.agentId} workspaceId={workspaceId} />;
}
