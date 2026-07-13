"use client";

import { Activity, AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";

export function StaleEntryAlert({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    console.log(
      `[workspaces] Stale entry detected for workspace ${workspaceId}, dispatching sidebar refresh`,
    );
    window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));
  }, [workspaceId]);

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
            Hive could not find a running agent for this workspace. It may have stopped, rebuilt, or
            been removed in Coder.
          </p>
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
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="size-4" aria-hidden="true" /> Retry
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
