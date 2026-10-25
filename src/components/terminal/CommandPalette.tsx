"use client";

import {
  Bot,
  Code,
  Folder,
  LoaderCircle,
  Monitor,
  Plus,
  Search,
  Terminal,
  Triangle,
} from "lucide-react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { useSwipeToDismiss } from "@/hooks/useSwipeToDismiss";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import { NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { rankCommandGroups } from "@/lib/terminal/command-search";
import { cn } from "@/lib/utils";
import { restoreWorkspaceFocus } from "@/lib/workspaces/window-focus";

const CREATE_SESSION_SHORTCUT_KEYS = ["ctrl+shift+n", "cmd+shift+n"] as const;

export interface CommandPaletteAction {
  id: string;
  label: string;
  description?: string;
  group: string;
  value?: string;
  aliases?: readonly string[];
  shortcut?: string;
  rightLabel?: string;
  disabled?: boolean;
  closeOnSelect?: boolean;
  icon?: "plus" | "search" | "terminal" | "files" | "code" | "desktop" | "agents";
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
  loadingText?: string;
  groupHeading?: string;
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
  loadingText?: string;
  groupHeading: string;
}

function PaletteLoading({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div
      role="status"
      aria-atomic="true"
      className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground"
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
      />
      <span>{text}</span>
    </div>
  );
}

function actionIcon(
  icon: CommandPaletteAction["icon"],
  className = "mr-2 size-4 shrink-0 opacity-70",
) {
  if (icon === "files") return <Folder className={className} />;
  if (icon === "code") return <Code className={className} />;
  if (icon === "desktop") return <Monitor className={className} />;
  if (icon === "agents") return <Bot className={className} />;
  if (icon === "search") return <Search className={className} />;
  if (icon === "plus") return <Plus className={className} />;
  return <Terminal className={className} />;
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
  loadingText,
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
    const entries = [
      ...actions.map((action) => ({ ...action, kind: "action" as const, action })),
      ...tabs.map((tab) => ({
        kind: "tab" as const,
        id: tab.id,
        label: tab.sessionName,
        group: groupHeading,
      })),
      ...(onCreateSession
        ? [
            {
              kind: "create" as const,
              id: "create-session",
              label: "New Session",
              group: "Actions",
            },
          ]
        : []),
    ];
    return rankCommandGroups(entries, searchValue ?? "");
  }, [actions, tabs, groupHeading, onCreateSession, searchValue]);

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
      if (action.closeOnSelect !== false) onOpenChange(false);
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
        aria-label="Search Hive"
        placeholder={searchPlaceholder}
        value={searchValue}
        onValueChange={onSearchValueChange}
      />
      <PaletteLoading text={loadingText} />
      <div className="flex min-h-0 flex-col">
        <div
          aria-hidden="true"
          data-testid="command-scroll-hint-up"
          data-visible={canScrollUp ? "true" : "false"}
          className={cn(
            "pointer-events-none flex h-5 shrink-0 items-center justify-center text-muted-foreground transition-opacity duration-150 motion-reduce:transition-none",
            canScrollUp ? "opacity-100" : "opacity-0",
          )}
        >
          <Triangle className="size-3 fill-current" />
        </div>
        <CommandList
          ref={commandListRef}
          className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={updateScrollHints}
        >
          {!loadingText ? <CommandEmpty>{emptyText}</CommandEmpty> : null}
          {actionGroups.map(([heading, groupActions]) => (
            <CommandGroup key={heading} heading={heading}>
              {groupActions.map((entry) => {
                if (entry.kind === "tab")
                  return (
                    <CommandItem
                      key={`tab:${entry.id}`}
                      value={`tab:${entry.id}`}
                      onSelect={() => handleSelect(entry.id)}
                    >
                      <Terminal className="mr-2 size-4 shrink-0 opacity-70" />
                      <span className="font-mono text-sm">{entry.label}</span>
                    </CommandItem>
                  );
                if (entry.kind === "create")
                  return (
                    <CommandItem
                      key="create-session"
                      value="create-session"
                      onSelect={handleCreate}
                    >
                      <Plus className="mr-2 size-4 shrink-0 opacity-70" />
                      <span>New Session</span>
                      <CommandShortcut>
                        {formatShortcut(CREATE_SESSION_SHORTCUT_KEYS)}
                      </CommandShortcut>
                    </CommandItem>
                  );
                const action = entry.action;
                return (
                  <CommandItem
                    key={`action:${action.id}`}
                    data-action-id={action.id}
                    tabIndex={0}
                    value={`action:${action.id}`}
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
                              if (action.closeOnSelect !== false) onOpenChange(false);
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
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
        <div
          aria-hidden="true"
          data-testid="command-scroll-hint-down"
          data-visible={canScrollDown ? "true" : "false"}
          className={cn(
            "pointer-events-none flex h-5 shrink-0 items-center justify-center text-muted-foreground transition-opacity duration-150 motion-reduce:transition-none",
            canScrollDown ? "opacity-100" : "opacity-0",
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
  loadingText,
  groupHeading = "Sessions",
}: CommandPaletteProps) {
  const isMobile = useIsMobile();
  const [localSearch, setLocalSearch] = useState("");
  const query = searchValue ?? localSearch;
  const changeSearch = useCallback(
    (value: string) => {
      setLocalSearch(value);
      onSearchValueChange?.(value);
    },
    [onSearchValueChange],
  );
  useEffect(() => {
    if (!open) setLocalSearch("");
  }, [open]);
  const { height } = useVisualViewportHeight();
  const sheetMaxHeight = height !== null ? `${height}px` : "100dvh";
  const { bindDragHandle, sheetStyle } = useSwipeToDismiss({
    enabled: isMobile,
    maxHeight: sheetMaxHeight,
    onDismiss: () => onOpenChange(false),
    open,
  });

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          finalFocus={restoreWorkspaceFocus}
          showCloseButton={false}
          data-launcher-gesture-ignore="true"
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
          <Command className={mobileCommandClassName} shouldFilter={false}>
            <CommandPaletteBody
              tabs={tabs}
              onSelectTab={onSelectTab}
              onOpenChange={onOpenChange}
              onCreateSession={onCreateSession}
              actions={actions}
              searchValue={query}
              onSearchValueChange={changeSearch}
              searchPlaceholder={searchPlaceholder}
              emptyText={emptyText}
              loadingText={loadingText}
              groupHeading={groupHeading}
            />
          </Command>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <CommandDialog
      commandShouldFilter={false}
      finalFocus={restoreWorkspaceFocus}
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="max-w-2xl top-[min(20vh,10rem)] translate-y-0 rounded-2xl border-primary/20 shadow-2xl"
    >
      <CommandPaletteBody
        tabs={tabs}
        onSelectTab={onSelectTab}
        onOpenChange={onOpenChange}
        onCreateSession={onCreateSession}
        actions={actions}
        searchValue={query}
        onSearchValueChange={changeSearch}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        loadingText={loadingText}
        groupHeading={groupHeading}
      />
    </CommandDialog>
  );
}
