"use client";

import { usePathname } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";

function isFullBleedWorkspaceRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname.endsWith("/terminal/workspace") || pathname.endsWith("/terminal/git-workspace");
}

export function DashboardSidebarTrigger() {
  const pathname = usePathname();
  if (isFullBleedWorkspaceRoute(pathname)) return null;

  return <SidebarTrigger className="mt-1 shrink-0" data-dashboard-sidebar-trigger="" />;
}
