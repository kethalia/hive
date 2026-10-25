"use client";

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { ShortcutTooltip } from "@/components/ui/shortcut-tooltip";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { GLOBAL_SIDEBAR_KEYS } from "@/lib/keyboard-shortcuts";
import { cn } from "@/lib/utils";

const headerButtonClassName =
  "size-10 min-h-10 shrink-0 p-0 max-[1024px]:size-11 max-[1024px]:min-h-11 pointer-coarse:size-11 pointer-coarse:min-h-11";

export function WorkspaceSidebarButton() {
  return (
    <ShortcutTooltip
      label="Toggle sidebar"
      shortcuts={GLOBAL_SIDEBAR_KEYS}
      trigger={<SidebarTrigger className={headerButtonClassName} />}
    />
  );
}

export function WorkspaceHeaderButton({
  label,
  shortcuts,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  label: string;
  shortcuts?: readonly string[];
}) {
  return (
    <ShortcutTooltip
      label={label}
      shortcuts={shortcuts}
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
