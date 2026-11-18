"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export function PanelTabs<T extends string>({
  label,
  items,
  value,
  onChange,
  busy,
  children,
}: {
  label: string;
  items: ReadonlyArray<{ id: T; label: string; icon: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  busy?: boolean;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () => setWide(element.clientWidth >= 368);
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!wide) {
      const tabs = list.current?.querySelectorAll<HTMLButtonElement>("[data-panel-section]");
      const active = tabs && Array.from(tabs).find((tab) => tab.dataset.panelSection === value);
      active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }, [value, wide]);

  return (
    <div ref={container} className="min-w-0">
      <Tabs
        orientation={wide ? "vertical" : "horizontal"}
        value={value}
        onValueChange={(next: T) => {
          if (!busy) onChange(next);
        }}
        className={cn(
          "min-h-0 min-w-0 gap-0",
          wide && "grid grid-cols-[minmax(6.25rem,27%)_minmax(0,1fr)]",
        )}
      >
        <TabsList
          ref={list}
          aria-label={label}
          className={cn(
            "sticky top-0 w-full min-w-0 gap-1 rounded-none bg-background px-1.5 py-2",
            wide ? "h-fit" : "z-10 !h-auto justify-start overflow-x-auto border-b",
          )}
        >
          {items.map((item) => (
            <TabsTrigger
              className={cn(
                "h-auto min-h-9 flex-none justify-start px-2 py-1.5 text-left text-xs leading-tight",
                wide && "whitespace-normal @lg:text-sm",
              )}
              data-panel-section={item.id}
              value={item.id}
              key={item.id}
              disabled={busy && value !== item.id}
            >
              {wide && (
                <span className="hidden @lg:inline-flex" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent
          value={value}
          className={cn(
            "min-h-0 min-w-0 px-3 py-3 @lg:px-5 @lg:py-4",
            wide && "border-l border-border/75",
          )}
        >
          {children}
        </TabsContent>
      </Tabs>
    </div>
  );
}
