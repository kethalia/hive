"use client";

import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatShortcut } from "@/lib/keyboard-shortcuts";

export function ShortcutTooltip({
  label,
  shortcuts,
  trigger,
}: {
  label: string;
  shortcuts?: readonly string[];
  trigger: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent side="bottom" sideOffset={8}>
        <span className="min-w-0">{label}</span>
        {shortcuts?.length ? (
          <kbd
            data-slot="kbd"
            className="shrink-0 rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
          >
            {formatShortcut(shortcuts)}
          </kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
