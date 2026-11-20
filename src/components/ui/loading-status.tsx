import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function LoadingStatus({
  children,
  placement = "inline",
}: {
  children: ReactNode;
  placement?: "inline" | "window" | "workspace";
}) {
  return (
    <span
      role="status"
      className={cn(
        "flex items-center gap-2 text-sm text-muted-foreground",
        placement === "workspace" && "h-full w-full justify-center p-4",
        placement === "window" && "p-4",
      )}
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
      />
      {children}
    </span>
  );
}
