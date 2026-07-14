import { redirect } from "next/navigation";

interface GitWorkspaceTerminalPageProps {
  params: Promise<{ id: string }>;
}

export default async function GitWorkspaceTerminalPage({ params }: GitWorkspaceTerminalPageProps) {
  const { id } = await params;
  redirect(`/workspaces/${encodeURIComponent(id)}/terminal/workspace`);
}
