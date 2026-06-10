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
        "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 border-b border-border pb-3 pt-[max(0.75rem,var(--safe-area-inset-top))] sm:grid-cols-[auto_minmax(0,1fr)_auto]",
        className,
      )}
      data-dashboard-page-nav=""
    >
      <SidebarTrigger className="mt-0.5 h-8 min-h-0 shrink-0" />
      <div className="min-w-0 space-y-1">
        {leading}
        <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? (
        <div className="col-span-2 flex min-w-0 items-center justify-end gap-2 sm:col-span-1">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
