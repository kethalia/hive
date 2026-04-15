import { redirect } from "next/navigation";

interface WorkspaceDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function WorkspaceDetailPage({
  params,
}: WorkspaceDetailPageProps) {
  const { id } = await params;
  redirect(`/workspaces/${id}/terminal`);
}
