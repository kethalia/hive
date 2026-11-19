export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LoadingStatus } from "@/components/ui/loading-status";
import { GeneralWorkspace } from "@/components/workspaces/GeneralWorkspace";
import { listWorkspacesAction } from "@/lib/actions/workspaces";
import { getSessionAction } from "@/lib/auth/actions";

async function WorkspaceContent() {
  const [result, session] = await Promise.all([listWorkspacesAction(), getSessionAction()]);
  if (!session?.data?.user) redirect("/login");
  return (
    <GeneralWorkspace
      userId={session.data.user.id}
      initialWorkspaces={result?.data ?? []}
      error={result?.serverError}
    />
  );
}

export default function WorkspacesPage() {
  return (
    <Suspense fallback={<LoadingStatus placement="workspace">Restoring workspace…</LoadingStatus>}>
      <WorkspaceContent />
    </Suspense>
  );
}
