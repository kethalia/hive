"use client";

import { Search } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { ShortcutTooltip } from "@/components/ui/shortcut-tooltip";
import { GLOBAL_COMMAND_PALETTE_KEYS } from "@/lib/keyboard-shortcuts";
import { openGlobalCommandPalette } from "@/lib/terminal/global-command-palette";
import { cn } from "@/lib/utils";

export const WORKSPACE_HEADER_BUTTON_CLASS_NAME =
  "size-10 min-h-10 shrink-0 p-0 max-[1024px]:size-11 max-[1024px]:min-h-11 pointer-coarse:size-11 pointer-coarse:min-h-11";

export function WorkspaceSearchButton() {
  return (
    <ShortcutTooltip
      label="Search Hive"
      shortcuts={GLOBAL_COMMAND_PALETTE_KEYS}
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className={WORKSPACE_HEADER_BUTTON_CLASS_NAME}
          aria-label="Search Hive"
          onClick={openGlobalCommandPalette}
        >
          <Search className="size-4" />
        </Button>
      }
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
          className={cn(WORKSPACE_HEADER_BUTTON_CLASS_NAME, className)}
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      }
    />
  );
}
