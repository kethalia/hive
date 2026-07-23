"use client";

import { ChevronRight, Plus, Search, Terminal, Triangle, X } from "lucide-react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSwipeToDismiss } from "@/hooks/useSwipeToDismiss";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import { NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { cn } from "@/lib/utils";

const CREATE_SESSION_SHORTCUT_KEYS = ["ctrl+shift+n", "cmd+shift+n"] as const;

export interface CommandPaletteAction {
  id: string;
  label: string;
  description?: string;
  group: string;
  value?: string;
  shortcut?: string;
  rightLabel?: string;
  disabled?: boolean;
  icon?: "plus" | "search" | "terminal";
  onSelect: () => void;
  options?: CommandPaletteActionOption[];
}

export interface CommandPaletteActionOption {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: Array<{ id: string; sessionName: string }>;
  onSelectTab: (tabId: string) => void;
  onCreateSession?: () => void;
  actions?: CommandPaletteAction[];
  searchValue?: string;
  onSearchValueChange?: (value: string) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  groupHeading?: string;
  mobileSide?: "bottom" | "right";
}

const mobileCommandClassName =
  "rounded-none bg-transparent shadow-none [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-group]]:px-2";

const dragHandleStyle: CSSProperties = {
  ...NO_TOUCH_STYLE,
  touchAction: "none",
};

interface CommandPaletteBodyProps {
  tabs: CommandPaletteProps["tabs"];
  onSelectTab: (tabId: string) => void;
  onOpenChange: (open: boolean) => void;
  onCreateSession?: () => void;
  actions: CommandPaletteAction[];
  searchValue?: string;
  onSearchValueChange?: (value: string) => void;
  searchPlaceholder: string;
  emptyText: string;
  groupHeading: string;
}

function actionIcon(
  icon: CommandPaletteAction["icon"],
  className = "mr-2 size-4 shrink-0 opacity-70",
) {
  if (icon === "search") return <Search className={className} />;
  if (icon === "plus") return <Plus className={className} />;
  return <Terminal className={className} />;
}

function actionMatchesQuery(action: CommandPaletteAction, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return [
    action.label,
    action.description,
    action.group,
    action.value,
    ...(action.options?.map((option) => option.label) ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .includes(normalizedQuery);
}

interface MobileSidebarActionProps {
  action: CommandPaletteAction;
  onOpenChange: (open: boolean) => void;
}

function MobileSidebarAction({ action, onOpenChange }: MobileSidebarActionProps) {
  const [open, setOpen] = useState(false);

  if (action.options) {
    return (
      <SidebarMenuItem>
        <Collapsible open={open} onOpenChange={setOpen} className="group/mobile-command">
          <SidebarMenuButton
            render={<CollapsibleTrigger />}
            size="lg"
            className="h-auto min-h-11 items-start py-2"
            disabled={action.disabled}
            data-testid={`mobile-command-disclosure-${action.id}`}
          >
            {actionIcon(action.icon, "mt-0.5 size-4 shrink-0 opacity-70")}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{action.label}</span>
              {action.description ? (
                <span className="block truncate text-xs text-sidebar-foreground/65">
                  {action.description}
                </span>
              ) : null}
            </span>
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
          </SidebarMenuButton>
          <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-150 motion-reduce:transition-none motion-reduce:duration-0 data-ending-style:h-0 data-starting-style:h-0">
            <fieldset className="grid grid-cols-2 gap-1 px-2 pb-2 pl-8">
              <legend className="sr-only">{action.label} actions</legend>
              {action.options.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto min-h-11 min-w-0 justify-start px-2 text-xs"
                  disabled={option.disabled}
                  data-testid={`mobile-command-option-${action.id}-${option.id}`}
                  onClick={() => {
                    if (option.disabled) return;
                    option.onSelect();
                    onOpenChange(false);
                  }}
                >
                  <span className="truncate">{option.label}</span>
                </Button>
              ))}
            </fieldset>
          </CollapsibleContent>
        </Collapsible>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<button type="button" />}
        size="lg"
        className="h-auto min-h-11 items-start py-2"
        disabled={action.disabled}
        onClick={() => {
          if (action.disabled) return;
          action.onSelect();
          onOpenChange(false);
        }}
      >
        {actionIcon(action.icon, "mt-0.5 size-4 shrink-0 opacity-70")}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{action.label}</span>
          {action.description ? (
            <span className="block truncate text-xs text-sidebar-foreground/65">
              {action.description}
            </span>
          ) : null}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function MobileSidebarPaletteBody({
  tabs,
  onSelectTab,
  onOpenChange,
  onCreateSession,
  actions,
  searchValue,
  onSearchValueChange,
  searchPlaceholder,
  emptyText,
  groupHeading,
}: CommandPaletteBodyProps) {
  const [localSearchValue, setLocalSearchValue] = useState("");
  const currentSearchValue = searchValue ?? localSearchValue;
  const normalizedQuery = currentSearchValue.trim().toLowerCase();
  const actionGroups = useMemo(() => {
    const groups = new Map<string, CommandPaletteAction[]>();
    for (const action of actions) {
      if (!actionMatchesQuery(action, normalizedQuery)) continue;
      const group = groups.get(action.group) ?? [];
      group.push(action);
      groups.set(action.group, group);
    }
    return [...groups.entries()];
  }, [actions, normalizedQuery]);
  const visibleTabs = useMemo(
    () =>
      tabs.filter(
        (tab) => !normalizedQuery || tab.sessionName.toLowerCase().includes(normalizedQuery),
      ),
    [normalizedQuery, tabs],
  );
  const showCreateSession =
    Boolean(onCreateSession) && (!normalizedQuery || "new session".includes(normalizedQuery));
  const hasResults = actionGroups.length > 0 || visibleTabs.length > 0 || showCreateSession;

  return (
    <>
      <SidebarGroup className="sticky top-0 z-10 border-b border-sidebar-border bg-sidebar p-2">
        <SidebarGroupContent className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-sidebar-foreground/55"
          />
          <SidebarInput
            type="search"
            aria-label="Search global navigation"
            autoComplete="off"
            enterKeyHint="search"
            spellCheck={false}
            placeholder={searchPlaceholder}
            value={currentSearchValue}
            className="h-11 pl-9 text-base"
            onChange={(event) => {
              const nextValue = event.currentTarget.value;
              setLocalSearchValue(nextValue);
              onSearchValueChange?.(nextValue);
            }}
          />
        </SidebarGroupContent>
      </SidebarGroup>

      {!hasResults ? (
        <p role="status" className="px-4 py-6 text-center text-sm text-sidebar-foreground/65">
          {emptyText}
        </p>
      ) : null}

      {actionGroups.map(([heading, groupActions]) => (
        <SidebarGroup key={heading} className="py-1">
          <SidebarGroupLabel>{heading}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {groupActions.map((action) => (
                <MobileSidebarAction key={action.id} action={action} onOpenChange={onOpenChange} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}

      {visibleTabs.length > 0 ? (
        <SidebarGroup className="py-1">
          <SidebarGroupLabel>{groupHeading}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleTabs.map((tab) => (
                <SidebarMenuItem key={tab.id}>
                  <SidebarMenuButton
                    render={<button type="button" />}
                    size="lg"
                    className="min-h-11"
                    onClick={() => {
                      onSelectTab(tab.id);
                      onOpenChange(false);
                    }}
                  >
                    <Terminal className="size-4 shrink-0 opacity-70" />
                    <span className="font-mono text-sm">{tab.sessionName}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}

      {showCreateSession ? (
        <SidebarGroup className="py-1">
          <SidebarGroupLabel>Actions</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<button type="button" />}
                  size="lg"
                  className="min-h-11"
                  onClick={() => {
                    if (!onCreateSession) return;
                    onCreateSession();
                    onOpenChange(false);
                  }}
                >
                  <Plus className="size-4 shrink-0 opacity-70" />
                  <span>New Session</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
    </>
  );
}

function selectedOptionIndex(
  action: CommandPaletteAction,
  selectedOptionIndexes: ReadonlyMap<string, number>,
): number {
  const storedIndex = selectedOptionIndexes.get(action.id);
  if (storedIndex !== undefined && !action.options?.at(storedIndex)?.disabled) return storedIndex;
  const firstEnabledIndex = action.options?.findIndex((option) => !option.disabled) ?? -1;
  return firstEnabledIndex >= 0 ? firstEnabledIndex : 0;
}

function CommandPaletteBody({
  tabs,
  onSelectTab,
  onOpenChange,
  onCreateSession,
  actions,
  searchValue,
  onSearchValueChange,
  searchPlaceholder,
  emptyText,
  groupHeading,
}: CommandPaletteBodyProps) {
  const commandListRef = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  const updateScrollHints = useCallback(() => {
    const list = commandListRef.current;
    if (!list) return;
    const nextCanScrollUp = list.scrollTop > 1;
    const nextCanScrollDown = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
    setCanScrollUp((current) => (current === nextCanScrollUp ? current : nextCanScrollUp));
    setCanScrollDown((current) => (current === nextCanScrollDown ? current : nextCanScrollDown));
  }, []);

  const handleSelect = useCallback(
    (tabId: string) => {
      onSelectTab(tabId);
      onOpenChange(false);
    },
    [onSelectTab, onOpenChange],
  );

  const handleCreate = useCallback(() => {
    onCreateSession?.();
    onOpenChange(false);
  }, [onCreateSession, onOpenChange]);
  const [selectedOptionIndexes, setSelectedOptionIndexes] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const actionGroups = useMemo(() => {
    const groups = new Map<string, CommandPaletteAction[]>();
    for (const action of actions) {
      const group = groups.get(action.group) ?? [];
      group.push(action);
      groups.set(action.group, group);
    }
    return [...groups.entries()];
  }, [actions]);

  useLayoutEffect(() => {
    updateScrollHints();
  });

  useEffect(() => {
    const list = commandListRef.current;
    if (!list) return;

    const mutationObserver = new MutationObserver(updateScrollHints);
    mutationObserver.observe(list, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    if (typeof ResizeObserver === "undefined") {
      return () => mutationObserver.disconnect();
    }

    const resizeObserver = new ResizeObserver(updateScrollHints);
    resizeObserver.observe(list);
    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [updateScrollHints]);

  const selectAction = useCallback(
    (action: CommandPaletteAction) => {
      const optionIndex = selectedOptionIndex(action, selectedOptionIndexes);
      const option = action.options?.at(optionIndex);
      if (option) {
        if (option.disabled) return;
        option.onSelect();
      } else {
        action.onSelect();
      }
      onOpenChange(false);
    },
    [onOpenChange, selectedOptionIndexes],
  );

  const handleActionKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        (event.key !== "Enter" || event.nativeEvent.isComposing)
      ) {
        return;
      }
      const selectedItem = event.currentTarget.querySelector<HTMLElement>(
        '[cmdk-item][aria-selected="true"][data-action-id]',
      );
      const searchInput = event.currentTarget.querySelector<HTMLElement>(
        '[data-slot="command-input"]',
      );
      if (event.target !== selectedItem && event.target !== searchInput) return;
      const actionId = selectedItem?.dataset.actionId;
      const action = actionId ? actions.find((candidate) => candidate.id === actionId) : undefined;
      const options = action?.options;
      if (!action || !options) return;
      if (event.key !== "Enter" && options.length < 2) return;

      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") {
        selectAction(action);
        return;
      }
      setSelectedOptionIndexes((current) => {
        const currentIndex = selectedOptionIndex(action, current);
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const enabledIndexes = options.flatMap((option, index) => (option.disabled ? [] : [index]));
        if (enabledIndexes.length === 0) return current;
        const currentPosition = enabledIndexes.indexOf(currentIndex);
        const nextPosition =
          (currentPosition + delta + enabledIndexes.length) % enabledIndexes.length;
        const nextIndex = enabledIndexes.at(nextPosition) ?? currentIndex;
        return new Map(current).set(action.id, nextIndex);
      });
    },
    [actions, selectAction],
  );

  return (
    <div onKeyDownCapture={handleActionKey}>
      <CommandInput
        placeholder={searchPlaceholder}
        value={searchValue}
        onValueChange={onSearchValueChange}
      />
      <div className="relative">
        <div
          aria-hidden="true"
          data-testid="command-scroll-hint-up"
          data-visible={canScrollUp ? "true" : "false"}
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-7 items-start justify-center bg-gradient-to-b from-popover via-popover/85 to-transparent pt-1 text-muted-foreground transition-[opacity,transform] duration-150 motion-reduce:transition-none",
            canScrollUp ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
          )}
        >
          <Triangle className="size-3 fill-current" />
        </div>
        <CommandList
          ref={commandListRef}
          className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={updateScrollHints}
        >
          <CommandEmpty>{emptyText}</CommandEmpty>
          {actionGroups.map(([heading, groupActions]) => (
            <CommandGroup key={heading} heading={heading}>
              {groupActions.map((action) => (
                <CommandItem
                  key={action.id}
                  data-action-id={action.id}
                  tabIndex={0}
                  value={action.value ?? `${action.label} ${action.description ?? ""}`}
                  onSelect={() => {
                    if (action.disabled) return;
                    selectAction(action);
                  }}
                  disabled={action.disabled}
                >
                  {actionIcon(action.icon)}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{action.label}</span>
                    {action.description ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {action.description}
                      </span>
                    ) : null}
                  </span>
                  {action.shortcut ? <CommandShortcut>{action.shortcut}</CommandShortcut> : null}
                  {action.options ? (
                    <span
                      className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-border/70 bg-background/70 p-0.5"
                      title="Choose action with Left and Right arrow keys"
                    >
                      {action.options.map((option, index) => (
                        <button
                          key={option.id}
                          type="button"
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
                            index === selectedOptionIndex(action, selectedOptionIndexes) &&
                              "bg-primary text-primary-foreground",
                            option.disabled && "opacity-40",
                          )}
                          data-testid={`command-option-${action.id}-${option.id}`}
                          data-selected={
                            index === selectedOptionIndex(action, selectedOptionIndexes)
                              ? "true"
                              : "false"
                          }
                          disabled={option.disabled}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (option.disabled) return;
                            option.onSelect();
                            onOpenChange(false);
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </span>
                  ) : action.rightLabel ? (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {action.rightLabel}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {tabs.length > 0 ? (
            <CommandGroup heading={groupHeading}>
              {tabs.map((tab) => (
                <CommandItem
                  key={tab.id}
                  value={tab.sessionName}
                  onSelect={() => {
                    handleSelect(tab.id);
                  }}
                >
                  <Terminal className="mr-2 size-4 shrink-0 opacity-70" />
                  <span className="font-mono text-sm">{tab.sessionName}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {onCreateSession && (
            <CommandGroup heading="Actions">
              <CommandItem onSelect={handleCreate}>
                <Plus className="mr-2 size-4 shrink-0 opacity-70" />
                <span>New Session</span>
                <CommandShortcut>{formatShortcut(CREATE_SESSION_SHORTCUT_KEYS)}</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
        <div
          aria-hidden="true"
          data-testid="command-scroll-hint-down"
          data-visible={canScrollDown ? "true" : "false"}
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-7 items-end justify-center bg-gradient-to-t from-popover via-popover/85 to-transparent pb-1 text-muted-foreground transition-[opacity,transform] duration-150 motion-reduce:transition-none",
            canScrollDown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
          )}
        >
          <Triangle className="size-3 rotate-180 fill-current" />
        </div>
      </div>
    </div>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  tabs,
  onSelectTab,
  onCreateSession,
  actions = [],
  searchValue,
  onSearchValueChange,
  searchPlaceholder = "Search sessions…",
  emptyText = "No sessions found.",
  groupHeading = "Sessions",
  mobileSide = "bottom",
}: CommandPaletteProps) {
  const isMobile = useIsMobile();
  const { height } = useVisualViewportHeight();
  const sheetMaxHeight = height !== null ? `${height}px` : "100dvh";
  const { bindDragHandle, sheetStyle } = useSwipeToDismiss({
    enabled: isMobile && mobileSide === "bottom",
    maxHeight: sheetMaxHeight,
    onDismiss: () => onOpenChange(false),
    open,
  });

  if (isMobile) {
    if (mobileSide === "right") {
      return (
        <Sidebar side="right" mobileOnly data-testid="global-command-sidebar">
          <SidebarHeader className="h-14 shrink-0 flex-row items-center justify-between border-b border-sidebar-border px-4">
            <h2 className="text-sm font-medium">Navigate</h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close global navigation"
              onClick={() => onOpenChange(false)}
            >
              <X />
            </Button>
          </SidebarHeader>
          <SidebarContent>
            <MobileSidebarPaletteBody
              tabs={tabs}
              onSelectTab={onSelectTab}
              onOpenChange={onOpenChange}
              onCreateSession={onCreateSession}
              actions={actions}
              searchValue={searchValue}
              onSearchValueChange={onSearchValueChange}
              searchPlaceholder={searchPlaceholder}
              emptyText={emptyText}
              groupHeading={groupHeading}
            />
          </SidebarContent>
        </Sidebar>
      );
    }

    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          data-sidebar-gesture-ignore="true"
          className="gap-0 overflow-hidden overscroll-contain rounded-t-2xl p-0 pb-safe motion-reduce:transition-none motion-reduce:duration-0"
          style={sheetStyle}
        >
          <SheetTitle className="sr-only">Command palette</SheetTitle>
          <button
            {...bindDragHandle()}
            type="button"
            aria-label="Drag to dismiss command palette"
            className="flex h-11 w-full shrink-0 items-center justify-center border-0 bg-transparent p-0 text-inherit"
            style={dragHandleStyle}
            onClick={() => onOpenChange(false)}
          >
            <span className="h-1 w-10 rounded-full bg-muted-foreground/35" aria-hidden="true" />
          </button>
          <Command className={mobileCommandClassName}>
            <CommandPaletteBody
              tabs={tabs}
              onSelectTab={onSelectTab}
              onOpenChange={onOpenChange}
              onCreateSession={onCreateSession}
              actions={actions}
              searchValue={searchValue}
              onSearchValueChange={onSearchValueChange}
              searchPlaceholder={searchPlaceholder}
              emptyText={emptyText}
              groupHeading={groupHeading}
            />
          </Command>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-2xl">
      <CommandPaletteBody
        tabs={tabs}
        onSelectTab={onSelectTab}
        onOpenChange={onOpenChange}
        onCreateSession={onCreateSession}
        actions={actions}
        searchValue={searchValue}
        onSearchValueChange={onSearchValueChange}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        groupHeading={groupHeading}
      />
    </CommandDialog>
  );
}
