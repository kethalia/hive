"use client";

import { usePathname } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";

function isFullBleedWorkspaceRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return (
    /\/workspaces\/[^/]+\/terminal$/.test(pathname) ||
    pathname.endsWith("/terminal/workspace") ||
    pathname.endsWith("/terminal/git-workspace")
  );
}

function hasPageNavbar(pathname: string | null): boolean {
  if (!pathname) return false;
  return (
    pathname === "/tasks" ||
    pathname.startsWith("/tasks/") ||
    pathname === "/workspaces" ||
    pathname === "/templates" ||
    pathname.startsWith("/templates/") ||
    pathname === "/terminal/status"
  );
}

export function DashboardSidebarTrigger() {
  const pathname = usePathname();
  if (isFullBleedWorkspaceRoute(pathname) || hasPageNavbar(pathname)) return null;

  return <SidebarTrigger className="mt-1 shrink-0" data-dashboard-sidebar-trigger="" />;
}
