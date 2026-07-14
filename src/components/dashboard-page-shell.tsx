import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function DashboardPageShell({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-dashboard-page-shell=""
      className={cn(
        "space-y-6 px-3 pb-safe sm:px-4 lg:px-6 [&>[data-dashboard-page-nav]]:-mx-3 sm:[&>[data-dashboard-page-nav]]:-mx-4 lg:[&>[data-dashboard-page-nav]]:-mx-6",
        className,
      )}
      {...props}
    />
  );
}
