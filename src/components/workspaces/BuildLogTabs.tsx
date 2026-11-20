"use client";

import { Ellipsis } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";

const tabSize = "max-w-40 border px-2 py-1.5 text-xs font-medium whitespace-nowrap";
const moreSize = "size-8 min-h-0 shrink-0 p-0";
const stageLabel = (stage: string) => stage || "All logs";

export function BuildLogTabs({
  stages,
  value,
  onChange,
}: {
  stages: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [fitted, setFitted] = useState<string[]>([]);

  useLayoutEffect(() => {
    const container = row.current;
    const measure = ruler.current;
    if (!container || !measure) return;
    function measureTabs() {
      if (!container || !measure) return;
      const available = Math.floor(container.getBoundingClientRect().width);
      const widths = Array.from(measure.children, (item) =>
        Math.ceil(item.getBoundingClientRect().width),
      );
      const menuWidth = widths.pop() ?? 0;
      let next = stages;
      if (widths.reduce((total, width) => total + width, 0) > available) {
        // Keep the active tab visible and make room for the overflow control.
        const selected = stages.indexOf(value);
        let remaining = available - menuWidth - widths[selected];
        next = stages.filter((_, index) => {
          if (index === selected) return true;
          if (widths[index] > remaining) return false;
          remaining -= widths[index];
          return true;
        });
      }
      setFitted((previous) =>
        previous.length === next.length && previous.every((stage, index) => stage === next[index])
          ? previous
          : next,
      );
    }

    measureTabs();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureTabs);
    observer.observe(container);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [stages, value]);

  const shown = stages.filter((stage) => stage === value || fitted.includes(stage));
  const hidden = stages.filter((stage) => !shown.includes(stage));

  return (
    <div ref={row} className="relative flex min-w-0 flex-1 items-center">
      <div
        ref={ruler}
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-s-0 top-0 flex w-max"
      >
        {stages.map((stage) => (
          <span key={stage} className={`${tabSize} shrink-0 truncate border-transparent`}>
            {stageLabel(stage)}
          </span>
        ))}
        <span className={moreSize} />
      </div>
      <TabsList
        aria-label="Build log stages"
        variant="line"
        className="min-w-0 justify-start gap-0 px-0 py-0"
      >
        {shown.map((stage) => (
          <TabsTrigger
            key={stage}
            value={stage}
            className={`${tabSize} min-w-0 flex-initial rounded-none group-data-horizontal/tabs:after:bottom-0`}
            title={stageLabel(stage)}
          >
            <span className="truncate">{stageLabel(stage)}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="More log stages"
                className={moreSize}
              />
            }
          >
            <Ellipsis aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-max max-w-64">
            <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
              {hidden.map((stage) => (
                <DropdownMenuRadioItem key={stage} value={stage} className="break-all">
                  {stageLabel(stage)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
