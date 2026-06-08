import { TerminalSessionStatusClient } from "@/components/workspaces/TerminalSessionStatusClient";

interface TerminalStatusPageProps {
  searchParams?: Promise<{ workspaceId?: string }>;
}

export default async function TerminalStatusPage({ searchParams }: TerminalStatusPageProps) {
  const params = await searchParams;
  const highlightedWorkspaceId = params?.workspaceId;

  return <TerminalSessionStatusClient highlightedWorkspaceId={highlightedWorkspaceId} />;
}
