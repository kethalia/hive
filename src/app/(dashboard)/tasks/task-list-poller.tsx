"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { POLL_INTERVAL_MS } from "@/lib/constants";

/**
 * Client component that wraps children and triggers a server data refresh
 * every 5 seconds via router.refresh(). This keeps the task list current
 * without a full page reload.
 */
export function TaskListPoller({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [router]);

  return <>{children}</>;
}
