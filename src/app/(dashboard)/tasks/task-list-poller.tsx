"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { POLL_INTERVAL_MS } from "@/lib/constants";

/**
 * Client component that wraps children and triggers a server data refresh
 * every 5 seconds via router.refresh(). This keeps the task list current
 * without a full page reload.
 */
export function TaskListPoller({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const refreshTasks = useCallback(() => {
    return router.refresh();
  }, [router]);

  useEffect(() => {
    const interval = setInterval(refreshTasks, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [refreshTasks]);

  return <PullToRefresh onRefresh={refreshTasks}>{children}</PullToRefresh>;
}
