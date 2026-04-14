import { getWorkspaceAgentAction } from "@/lib/actions/workspaces";
import { TerminalClient } from "./terminal-client";

interface TerminalPageProps {
  params: Promise<{ id: string }>;
}

export default async function TerminalPage({ params }: TerminalPageProps) {
  const { id: workspaceId } = await params;

  const result = await getWorkspaceAgentAction({ workspaceId });

  if (!result?.data) {
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

  return (
    <TerminalClient
      agentId={result.data.agentId}
      coderUrl={coderUrl}
    />
  );
}
