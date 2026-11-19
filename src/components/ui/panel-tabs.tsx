"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export interface PanelTabsNavigation {
  id: string;
  collapsed: boolean;
}

export function PanelTabs<T extends string>({
  label,
  items,
  value,
  onChange,
  busy,
  navigation,
  children,
}: {
  label: string;
  items: ReadonlyArray<{ id: T; label: string; icon: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  busy?: boolean;
  navigation?: PanelTabsNavigation;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const collapsed = navigation?.collapsed ?? false;

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
    if (!wide && !collapsed) {
      const tabs = list.current?.querySelectorAll<HTMLButtonElement>("[data-panel-section]");
      const active = tabs && Array.from(tabs).find((tab) => tab.dataset.panelSection === value);
      const rail = list.current;
      if (active && rail) {
        const { left, right } = active.getBoundingClientRect();
        const bounds = rail.getBoundingClientRect();
        rail.scrollLeft +=
          left < bounds.left ? left - bounds.left : Math.max(0, right - bounds.right);
      }
    }
  }, [value, wide, collapsed]);

  return (
    <div ref={container} className="@container flex min-w-0 flex-1 flex-col">
      <Tabs
        orientation={wide ? "vertical" : "horizontal"}
        value={value}
        onValueChange={(next: T) => {
          if (!busy) onChange(next);
        }}
        className={cn(
          "min-h-0 min-w-0 flex-1 gap-0",
          wide &&
            "grid transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none",
          wide && (collapsed ? "grid-cols-[0%_minmax(0,1fr)]" : "grid-cols-[27%_minmax(0,1fr)]"),
        )}
      >
        <div
          id={navigation?.id}
          inert={collapsed}
          aria-hidden={collapsed || undefined}
          className={cn(
            "min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
            wide ? "overflow-x-clip" : "grid",
            !wide && (collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"),
            collapsed && "opacity-0",
          )}
        >
          <div
            className={cn(
              wide
                ? "h-full w-[27cqw] border-r border-border/75 bg-background"
                : "min-h-0 overflow-hidden",
            )}
          >
            <TabsList
              ref={list}
              aria-label={label}
              className={cn(
                "w-full min-w-0 gap-1 rounded-none bg-background px-1.5 py-2",
                wide ? "sticky top-0 h-fit" : "!h-auto justify-start overflow-x-auto border-b",
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
          </div>
        </div>
        <TabsContent value={value} className="min-h-0 min-w-0 px-3 py-3 @lg:px-5 @lg:py-4">
          {children}
        </TabsContent>
      </Tabs>
    </div>
  );
}
