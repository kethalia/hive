export const dynamic = "force-dynamic";

import { listWorkspacesAction } from "@/lib/actions/workspaces";
import { WorkspaceListContent } from "./workspace-list-content";
import { WorkspaceListPoller } from "./workspace-list-poller";

interface WorkspacesPageProps {
  searchParams?: Promise<{ launch?: string }>;
}

export default async function WorkspacesPage({ searchParams }: WorkspacesPageProps = {}) {
  const result = await listWorkspacesAction();
  const query = await searchParams;
  const workspaces = result?.data ?? [];
  const shouldPoll = workspaces.some((workspace) =>
    ["pending", "starting", "stopping", "deleting", "canceling"].includes(
      workspace.latest_build.status,
    ),
  );

  return (
    <WorkspaceListPoller shouldPoll={shouldPoll}>
      <WorkspaceListContent
        workspaces={workspaces}
        error={result?.serverError ?? null}
        launchOnMount={query?.launch === "1"}
      />
    </WorkspaceListPoller>
  );
}
