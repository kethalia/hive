export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { GeneralWorkspace } from "@/components/workspaces/GeneralWorkspace";
import { listWorkspacesAction } from "@/lib/actions/workspaces";
import { getSessionAction } from "@/lib/auth/actions";

export default async function WorkspacesPage() {
  const [result, session] = await Promise.all([listWorkspacesAction(), getSessionAction()]);
  if (!session?.data?.user)
    return (
      <p role="alert" className="p-4">
        Sign in to open your workspace.
      </p>
    );
  return (
    <Suspense
      fallback={
        <p role="status" className="p-4">
          Loading workspace…
        </p>
      }
    >
      <GeneralWorkspace
        userId={session.data.user.id}
        initialWorkspaces={result?.data ?? []}
        error={result?.serverError}
      />
    </Suspense>
  );
}
