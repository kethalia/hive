"use client";

import type { ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface DashboardPageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  leading?: ReactNode;
  className?: string;
}

export function DashboardPageHeader({
  title,
  description,
  actions,
  leading,
  className,
}: DashboardPageHeaderProps) {
  return (
    <header
      className={cn(
        "flex h-14 min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-sidebar-border bg-background/85 px-3 py-2 pt-[max(0.5rem,var(--safe-area-inset-top))] backdrop-blur-md sm:flex-nowrap sm:px-4",
        className,
      )}
      data-dashboard-page-nav=""
    >
      <SidebarTrigger className="h-8 min-h-0 shrink-0" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {leading}
        <h1 className="truncate text-sm font-medium uppercase tracking-[0.08em] text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex w-full min-w-0 shrink-0 items-center justify-end gap-2 overflow-hidden pl-11 sm:w-auto sm:pl-0">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
