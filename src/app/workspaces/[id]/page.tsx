import Link from "next/link";
import {
  getWorkspaceAction,
  getWorkspaceAgentAction,
} from "@/lib/actions/workspaces";
import { WorkspaceToolPanel } from "@/components/workspaces/WorkspaceToolPanel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { AlertCircle } from "lucide-react";

interface WorkspaceDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function WorkspaceDetailPage({
  params,
}: WorkspaceDetailPageProps) {
  const { id: workspaceId } = await params;

  const [workspaceResult, agentResult] = await Promise.all([
    getWorkspaceAction({ workspaceId }),
    getWorkspaceAgentAction({ workspaceId }),
  ]);

  if (!workspaceResult?.data) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-4 text-center">
          <Alert variant="destructive" className="max-w-md">
            <AlertCircle />
            <AlertDescription>
              Could not load workspace data. It may have been deleted or you may
              not have access.
            </AlertDescription>
          </Alert>
          <Link
            href="/workspaces"
            className="text-sm text-primary hover:underline"
          >
            Back to workspaces
          </Link>
        </div>
      </div>
    );
  }

  const agentName = agentResult?.data?.agentName ?? "main";
  const coderUrl = process.env.CODER_URL ?? "";

  return (
    <div className="flex h-screen flex-col gap-4 p-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/workspaces" />}>
              Workspaces
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{workspaceResult.data.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <WorkspaceToolPanel
        workspace={workspaceResult.data}
        agentName={agentName}
        coderUrl={coderUrl}
      />
    </div>
  );
}
