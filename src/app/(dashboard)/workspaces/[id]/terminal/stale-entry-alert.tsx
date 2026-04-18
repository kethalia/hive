"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

export function StaleEntryAlert({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    console.log(`[workspaces] Stale entry detected for workspace ${workspaceId}, dispatching sidebar refresh`);
    window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));
  }, [workspaceId]);

  return (
    <div className="-m-6 -mt-14 flex h-[100vh] w-[calc(100%+3rem)] items-center justify-center">
      <Alert variant="destructive" className="max-w-md">
        <AlertCircle />
        <AlertDescription className="space-y-2">
          <p>Could not find a running agent for this workspace.</p>
          <Link href="/tasks" className="text-sm underline">
            Back to home
          </Link>
        </AlertDescription>
      </Alert>
    </div>
  );
}
