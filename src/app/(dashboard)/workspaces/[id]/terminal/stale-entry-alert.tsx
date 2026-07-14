"use client";

import { Activity, AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { restartWorkspaceAction } from "@/lib/actions/workspaces";
import type { WorkspaceAgentStatus } from "@/lib/coder/types";

export function StaleEntryAlert({
  workspaceId,
  agentStatus,
}: {
  workspaceId: string;
  agentStatus?: WorkspaceAgentStatus;
}) {
  const router = useRouter();
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  useEffect(() => {
    console.log(
      `[workspaces] Stale entry detected for workspace ${workspaceId}, dispatching sidebar refresh`,
    );
    window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));
  }, [workspaceId]);

  async function restartWorkspace() {
    setIsRestarting(true);
    setRestartError(null);
    try {
      const result = await restartWorkspaceAction({ workspaceId });
      if (!result?.data) {
        setRestartError(result?.serverError ?? "Workspace restart failed.");
        return;
      }
      window.dispatchEvent(new CustomEvent("hive:sidebar-refresh", { detail: { workspaceId } }));
      router.refresh();
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : "Workspace restart failed.");
    } finally {
      setIsRestarting(false);
    }
  }

  return (
    <div
      className="flex h-full min-h-0 w-full items-center justify-center overflow-y-auto p-4"
      data-dashboard-full-bleed=""
    >
      <Alert variant="destructive" className="max-w-xl">
        <AlertCircle className="size-5" />
        <h1 className="col-start-2 font-medium">Workspace session is unavailable</h1>
        <AlertDescription className="space-y-5">
          <p>
            {agentStatus
              ? `The workspace agent is ${agentStatus}. Terminal sessions cannot connect until the agent is online.`
              : "Hive could not find a running agent for this workspace. It may have stopped, rebuilt, or been removed in Coder."}
          </p>
          {restartError && <p className="text-destructive-foreground">{restartError}</p>}
          <div className="flex flex-wrap gap-3">
            <Link className={buttonVariants({ variant: "outline" })} href="/workspaces">
              <ArrowLeft className="size-4" aria-hidden="true" /> Workspaces
            </Link>
            <Link
              className={buttonVariants({ variant: "outline" })}
              href={`/terminal/status?workspaceId=${encodeURIComponent(workspaceId)}`}
            >
              <Activity className="size-4" aria-hidden="true" /> Diagnostics
            </Link>
            <Button
              type="button"
              aria-label="Retry workspace session"
              onClick={() => {
                window.location.reload();
              }}
            >
              <RefreshCw className="size-4" aria-hidden="true" /> Retry
            </Button>
            {agentStatus && agentStatus !== "connected" && (
              <Button type="button" onClick={restartWorkspace} disabled={isRestarting}>
                <RefreshCw
                  className={`size-4 ${isRestarting ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {isRestarting ? "Restarting…" : "Restart workspace"}
              </Button>
            )}
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
