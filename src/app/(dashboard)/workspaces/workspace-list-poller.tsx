"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";

export function WorkspaceListPoller({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const refreshWorkspaces = useCallback(() => {
    return router.refresh();
  }, [router]);

  return (
    <PullToRefresh onRefresh={refreshWorkspaces} data-refresh-surface="workspaces-list">
      {children}
    </PullToRefresh>
  );
}
