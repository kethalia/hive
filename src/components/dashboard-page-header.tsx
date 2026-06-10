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
        "flex min-h-11 items-center gap-2 border-b border-border px-2 py-1 pt-[max(0.25rem,var(--safe-area-inset-top))]",
        className,
      )}
      data-dashboard-page-nav=""
    >
      <SidebarTrigger className="h-8 min-h-0 shrink-0" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {leading}
        <h1 className="truncate text-sm font-normal text-foreground">{title}</h1>
        {description ? (
          <p className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 overflow-hidden">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
