"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { POLL_INTERVAL_MS } from "@/lib/constants";

interface WorkspaceListPollerProps {
  children: React.ReactNode;
  shouldPoll?: boolean;
}

export function WorkspaceListPoller({ children, shouldPoll = false }: WorkspaceListPollerProps) {
  const router = useRouter();
  const refreshWorkspaces = useCallback(() => {
    return router.refresh();
  }, [router]);

  useEffect(() => {
    if (!shouldPoll) return;
    const interval = window.setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [router, shouldPoll]);

  return (
    <PullToRefresh onRefresh={refreshWorkspaces} data-refresh-surface="workspaces-list">
      {children}
    </PullToRefresh>
  );
}
