export const dynamic = "force-dynamic";

import { listWorkspacesAction } from "@/lib/actions/workspaces";
import { WorkspaceListContent } from "./workspace-list-content";
import { WorkspaceListPoller } from "./workspace-list-poller";

export default async function WorkspacesPage() {
  const result = await listWorkspacesAction();

  return (
    <WorkspaceListPoller>
      <WorkspaceListContent workspaces={result?.data ?? []} error={result?.serverError ?? null} />
    </WorkspaceListPoller>
  );
}
