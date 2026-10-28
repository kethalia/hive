"use client";

import {
  ArrowLeft,
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
import { useVisualViewportKeyboardOffset } from "@/hooks/useVisualViewportKeyboardOffset";
import { NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import { rankCommandGroups } from "@/lib/terminal/command-search";
import { cn } from "@/lib/utils";
import { restoreWorkspaceFocus } from "@/lib/workspaces/window-focus";

export type CommandPaletteNavigation = { page: string } | { back: true };

export interface CommandPalettePage {
  title: string;
  actions: CommandPaletteAction[];
  searchPlaceholder?: string;
  loadingText?: string;
  emptyText?: string;
  input?: {
    label: string;
    maxLength: number;
    submitLabel: string;
    pendingLabel: string;
    onSubmit: (
      value: string,
    ) => Promise<void> | Promise<CommandPaletteNavigation> | CommandPaletteNavigation;
  };
}

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
  onSelect: (() => void) | (() => CommandPaletteNavigation);
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
  pages?: Record<string, CommandPalettePage>;
  searchValue?: string;
  onSearchValueChange?: (value: string) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  loadingText?: string;
  groupHeading?: string;
}

const mobileCommandClassName =
  "min-h-0 flex-1 overflow-clip rounded-none bg-transparent shadow-none [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]]:shrink-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-group]]:px-2 [&_[cmdk-list]]:max-h-none [&_[cmdk-list]]:flex-1";

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
  page?: CommandPalettePage;
  onBack?: () => void;
  onNavigate: (navigation: CommandPaletteNavigation) => void;
  onSubmit: (value: string) => void;
  busy: boolean;
  error: string;
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
  page,
  onBack,
  onNavigate,
  onSubmit,
  busy,
  error,
}: CommandPaletteBodyProps) {
  const commandListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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

  const filterQuery = page?.input ? "" : searchValue;
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
    return rankCommandGroups(entries, filterQuery ?? "");
  }, [actions, tabs, groupHeading, onCreateSession, filterQuery]);

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
        const navigation = action.onSelect();
        if (
          navigation &&
          typeof navigation === "object" &&
          ("page" in navigation || "back" in navigation)
        ) {
          onNavigate(navigation);
          return;
        }
      }
      if (action.closeOnSelect !== false) onOpenChange(false);
    },
    [onOpenChange, onNavigate, selectedOptionIndexes],
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
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={(event) => {
        if (
          onBack &&
          !event.nativeEvent.isComposing &&
          (event.key === "Escape" ||
            (event.key === "Backspace" &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              !searchValue &&
              event.target instanceof HTMLInputElement))
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onBack();
          return;
        }
        if (
          page?.input &&
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          event.target === inputRef.current &&
          !event.currentTarget.querySelector('[cmdk-item][aria-selected="true"]')
        ) {
          event.preventDefault();
          event.stopPropagation();
          onSubmit(inputRef.current?.value ?? "");
          return;
        }
        handleActionKey(event);
      }}
    >
      {onBack ? (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <button
            type="button"
            aria-label="Back"
            disabled={busy}
            onClick={onBack}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <ArrowLeft className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{page?.title}</span>
          <span className="text-xs text-muted-foreground">Esc to go back</span>
        </div>
      ) : null}
      <CommandInput
        ref={inputRef}
        autoFocus
        aria-label={page?.input?.label ?? "Search Hive"}
        maxLength={page?.input?.maxLength}
        readOnly={busy}
        aria-invalid={!!error}
        aria-describedby={error ? "command-page-error" : undefined}
        placeholder={searchPlaceholder}
        value={searchValue}
        onValueChange={onSearchValueChange}
      />
      <PaletteLoading text={busy ? page?.input?.pendingLabel : loadingText} />
      {error ? (
        <p id="command-page-error" role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
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
          {!loadingText && !page?.input ? <CommandEmpty>{emptyText}</CommandEmpty> : null}
          {page?.input ? (
            <CommandGroup>
              <CommandItem
                value="submit-page"
                disabled={busy}
                onSelect={() => onSubmit(inputRef.current?.value ?? searchValue ?? "")}
              >
                <Plus className="mr-2 size-4" />
                <span className="min-w-0 flex-1 truncate">{page.input.submitLabel}</span>
                <CommandShortcut>Enter</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          ) : null}
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
                      if (busy || action.disabled) return;
                      selectAction(action);
                    }}
                    disabled={busy || action.disabled}
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
  pages = {},
  searchValue,
  onSearchValueChange,
  searchPlaceholder = "Search sessions…",
  emptyText = "No sessions found.",
  loadingText,
  groupHeading = "Sessions",
}: CommandPaletteProps) {
  const isMobile = useIsMobile();
  const [localSearch, setLocalSearch] = useState("");
  const changeSearch = useCallback(
    (value: string) => {
      setLocalSearch(value);
      onSearchValueChange?.(value);
    },
    [onSearchValueChange],
  );
  const [stack, setStack] = useState<Array<{ id: string; query: string }>>([]);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pageId = stack.at(-1)?.id;
  const page = pageId
    ? (pages[pageId] ?? {
        title: pageId.replace(/^section:/, ""),
        actions: [],
        emptyText: "No options are currently available.",
      })
    : undefined;
  // Discovery publishes search updates through an effect. Creation drafts must
  // update immediately, without an older search snapshot replacing typed text.
  const query = page?.input ? localSearch : (searchValue ?? localSearch);
  const navigate = useCallback(
    (navigation: CommandPaletteNavigation) => {
      if (pending.current) return;
      setError("");
      if ("back" in navigation) {
        const previous = stack.at(-1);
        if (!previous) return;
        setDirection("back");
        setStack(stack.slice(0, -1));
        changeSearch(previous.query);
      } else {
        setDirection("forward");
        setStack([...stack, { id: navigation.page, query }]);
        changeSearch("");
      }
    },
    [stack, query, changeSearch],
  );
  const changeOpen = useCallback(
    (next: boolean) => {
      if (!pending.current) onOpenChange(next);
    },
    [onOpenChange],
  );
  async function submit(value: string) {
    if (!page?.input || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const navigation = await page.input.onSubmit(value.trim());
      if (!mounted.current) return;
      pending.current = false;
      if (navigation) navigate(navigation);
      else onOpenChange(false);
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : "Could not open the window.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!open) {
      setLocalSearch("");
      setStack([]);
      setError("");
      setDirection("forward");
    }
  }, [open]);
  const body = (
    <div
      key={pageId ?? "root"}
      data-command-page={pageId ?? "root"}
      data-direction={direction}
      className={cn(
        "command-page flex min-h-0 flex-1 flex-col",
        (pageId || direction === "back") && `command-page-${direction}`,
      )}
    >
      <CommandPaletteBody
        tabs={page ? [] : tabs}
        onSelectTab={onSelectTab}
        onOpenChange={changeOpen}
        onCreateSession={page ? undefined : onCreateSession}
        actions={page?.actions ?? actions}
        searchValue={query}
        onSearchValueChange={(value) => {
          if (!pending.current) {
            setError("");
            changeSearch(value);
          }
        }}
        searchPlaceholder={page?.searchPlaceholder ?? searchPlaceholder}
        emptyText={page?.emptyText ?? emptyText}
        loadingText={page ? page.loadingText : loadingText}
        groupHeading={groupHeading}
        page={page}
        onBack={page ? () => navigate({ back: true }) : undefined}
        onNavigate={navigate}
        onSubmit={(value) => {
          void submit(value);
        }}
        busy={busy}
        error={error}
      />
    </div>
  );
  const { liftPx, isKeyboardVisible, visualViewportHeightPx } = useVisualViewportKeyboardOffset();
  const viewportHeight = visualViewportHeightPx > 0 ? `${visualViewportHeightPx}px` : "100dvh";
  const restingHeight =
    visualViewportHeightPx > 0 ? `${Math.round(visualViewportHeightPx * 0.82)}px` : "82dvh";
  const sheetMaxHeight = `calc(${viewportHeight} - max(1rem, var(--safe-area-inset-top)) - 0.5rem)`;
  const { bindDragHandle, sheetStyle } = useSwipeToDismiss({
    enabled: isMobile,
    maxHeight: sheetMaxHeight,
    onDismiss: () => changeOpen(false),
    open,
  });

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={changeOpen}>
        <SheetContent
          side="bottom"
          finalFocus={restoreWorkspaceFocus}
          showCloseButton={false}
          data-launcher-gesture-ignore="true"
          className="gap-0 overflow-hidden overscroll-contain rounded-t-2xl px-[max(1rem,var(--safe-area-inset-left))] pr-[max(1rem,var(--safe-area-inset-right))] pt-0 pb-[max(0.75rem,var(--safe-area-inset-bottom))] transition-[transform,opacity] motion-reduce:transition-none motion-reduce:duration-0"
          style={{
            ...sheetStyle,
            bottom: liftPx,
            height: isKeyboardVisible ? sheetMaxHeight : `min(40rem, ${restingHeight})`,
          }}
        >
          <SheetTitle className="sr-only">Command palette</SheetTitle>
          <button
            {...bindDragHandle()}
            type="button"
            aria-label="Drag to dismiss command palette"
            className="flex h-11 w-full shrink-0 items-center justify-center border-0 bg-transparent p-0 text-inherit"
            style={dragHandleStyle}
            onClick={() => changeOpen(false)}
          >
            <span className="h-1 w-10 rounded-full bg-muted-foreground/35" aria-hidden="true" />
          </button>
          <Command
            key={pageId ?? "root"}
            defaultValue={page?.input ? "submit-page" : undefined}
            label={page?.input?.label ?? page?.title ?? "Search Hive"}
            className={mobileCommandClassName}
            disablePointerSelection
            shouldFilter={false}
          >
            {body}
          </Command>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <CommandDialog
      commandKey={pageId ?? "root"}
      commandLabel={page?.input?.label ?? page?.title ?? "Search Hive"}
      commandDefaultValue={page?.input ? "submit-page" : undefined}
      commandShouldFilter={false}
      finalFocus={restoreWorkspaceFocus}
      open={open}
      onOpenChange={changeOpen}
      contentClassName="max-w-2xl top-[min(20vh,10rem)] translate-y-0 rounded-2xl border-primary/20 shadow-2xl"
    >
      {body}
    </CommandDialog>
  );
}
