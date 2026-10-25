"use client";

import type { ComponentProps, ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const headerButtonClassName =
  "size-10 min-h-10 shrink-0 p-0 max-[1024px]:size-11 max-[1024px]:min-h-11 pointer-coarse:size-11 pointer-coarse:min-h-11";

function HeaderTooltip({ label, trigger }: { label: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent side="bottom" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function WorkspaceSidebarButton() {
  return (
    <HeaderTooltip
      label="Toggle sidebar"
      trigger={<SidebarTrigger className={headerButtonClassName} />}
    />
  );
}

export function WorkspaceHeaderButton({
  label,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & { label: string }) {
  return (
    <HeaderTooltip
      label={label}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(headerButtonClassName, className)}
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      }
    />
  );
}
