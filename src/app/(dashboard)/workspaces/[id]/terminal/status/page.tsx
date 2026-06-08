import { redirect } from "next/navigation";

interface TerminalStatusRedirectPageProps {
  params: Promise<{ id: string }>;
}

export default async function TerminalStatusRedirectPage({
  params,
}: TerminalStatusRedirectPageProps) {
  const { id: workspaceId } = await params;
  redirect(`/terminal/status?workspaceId=${encodeURIComponent(workspaceId)}`);
}
