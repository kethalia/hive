import { TerminalSessionStatusClient } from "@/components/workspaces/TerminalSessionStatusClient";

interface TerminalStatusPageProps {
  params: Promise<{ id: string }>;
}

export default async function TerminalStatusPage({ params }: TerminalStatusPageProps) {
  const { id: workspaceId } = await params;
  return <TerminalSessionStatusClient workspaceId={workspaceId} />;
}
