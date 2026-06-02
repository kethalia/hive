"use client";

import type { LucideIcon } from "lucide-react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  CornerDownLeft,
  DoorOpen,
  List,
  MessageSquareText,
  Minus,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type { PointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";
import { VIRTUAL_KEY_SEQUENCES } from "@/lib/terminal/virtual-keys";
import { cn } from "@/lib/utils";

const NAVIGATION_KEYS = [
  { label: "Up", icon: ArrowUp, sequence: VIRTUAL_KEY_SEQUENCES.Up },
  { label: "Down", icon: ArrowDown, sequence: VIRTUAL_KEY_SEQUENCES.Down },
  { label: "Left", icon: ArrowLeft, sequence: VIRTUAL_KEY_SEQUENCES.Left },
  { label: "Right", icon: ArrowRight, sequence: VIRTUAL_KEY_SEQUENCES.Right },
] as const;

const QUICK_ROW_KEYS = [
  { label: "Enter", icon: CornerDownLeft, sequence: VIRTUAL_KEY_SEQUENCES.Enter },
  { label: "Tab", icon: ArrowRightToLine, sequence: VIRTUAL_KEY_SEQUENCES.Tab },
  { label: "Esc", icon: DoorOpen, sequence: VIRTUAL_KEY_SEQUENCES.Esc },
  { label: "Ctrl+C", icon: X, sequence: VIRTUAL_KEY_SEQUENCES.CtrlC },
] as const;

const CONTROL_PAGES = ["Keys", "Navigation", "Windows", "Compose", "Font size"] as const;
const STACKED_BUTTON_CLASS = "min-h-14 min-w-0 flex-col gap-1 px-1 py-2 text-xs leading-none";

interface MobileTerminalWindowSession {
  name: string;
}

export interface MobileTerminalWindowNavigation {
  sessions?: MobileTerminalWindowSession[];
  current?: MobileTerminalWindowSession | null;
  previous?: MobileTerminalWindowSession | null;
  next?: MobileTerminalWindowSession | null;
  canGoPrevious?: boolean;
  canGoNext?: boolean;
  loading?: boolean;
  error?: string | null;
  select?: (sessionName: string) => boolean | void;
  reload?: () => void;
  onOpenSwitcher?: () => void;
}

function MobileControlButtonContent({ label, Icon }: { label: string; Icon: LucideIcon }) {
  return (
    <>
      <span className="block w-full text-center font-medium leading-none">{label}</span>
      <Icon aria-hidden="true" className="size-4" />
    </>
  );
}

function getWindowNavigationStatus(windowNavigation?: MobileTerminalWindowNavigation): string {
  if (!windowNavigation) return "Window navigation unavailable";
  if (windowNavigation.loading) return "Loading terminal windows";
  if (windowNavigation.error) return `Terminal window navigation error: ${windowNavigation.error}`;

  const windowCount = windowNavigation.sessions?.length ?? 0;
  if (windowCount <= 0) return "No terminal windows are available";
  if (windowCount === 1) return "Only one terminal window is available";
  if (!windowNavigation.current) return `${windowCount} terminal windows available`;

  return `Current terminal window: ${windowNavigation.current.name}. ${windowCount} windows available.`;
}

function getWindowStepDisabledReason(
  direction: "previous" | "next",
  windowNavigation?: MobileTerminalWindowNavigation,
): string | undefined {
  if (!windowNavigation) return "Window navigation unavailable";
  if (windowNavigation.loading) return "Loading terminal windows";
  if (windowNavigation.error) return "Terminal windows could not be loaded";
  if (!windowNavigation.select) return "Window switching unavailable";
  if ((windowNavigation.sessions?.length ?? 0) <= 1) return "Only one terminal window is available";
  if (direction === "previous" && (!windowNavigation.canGoPrevious || !windowNavigation.previous)) {
    return "Already at the first terminal window";
  }
  if (direction === "next" && (!windowNavigation.canGoNext || !windowNavigation.next)) {
    return "Already at the last terminal window";
  }
  return undefined;
}

export interface MobileTerminalControlsProps {
  isKeyboardVisible?: boolean;
  /** Called once for each terminal action press and page-dot navigation. */
  onHapticFeedback?: () => void;
  windowNavigation?: MobileTerminalWindowNavigation;
}

export function MobileTerminalControls({
  isKeyboardVisible = false,
  onHapticFeedback,
  windowNavigation,
}: MobileTerminalControlsProps = {}) {
  const { activeSend } = useKeybindings();
  const [carouselApi, setCarouselApi] = useState<CarouselApi>();
  const [currentPage, setCurrentPage] = useState(0);
  const {
    size: fontSize,
    increase: increaseFontSize,
    decrease: decreaseFontSize,
    canIncrease,
    canDecrease,
  } = useTerminalFontStep();

  const haptic = useCallback(() => {
    onHapticFeedback?.();
  }, [onHapticFeedback]);

  const keepTerminalKeyboardOpen = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const sendKey = useCallback(
    (sequence: string) => {
      haptic();
      activeSend?.(sequence);
    },
    [activeSend, haptic],
  );

  const openCompose = useCallback(() => {
    haptic();
    window.dispatchEvent(new CustomEvent(TERMINAL_COMPOSE_OPEN_EVENT));
  }, [haptic]);

  const switchWindow = useCallback(
    (session?: MobileTerminalWindowSession | null) => {
      if (!session || !windowNavigation?.select) return;
      const selected = windowNavigation.select(session.name);
      if (selected !== false) haptic();
    },
    [haptic, windowNavigation],
  );

  const openWindowSwitcher = useCallback(() => {
    if (!windowNavigation?.onOpenSwitcher) return;
    haptic();
    windowNavigation.onOpenSwitcher();
  }, [haptic, windowNavigation]);

  const reloadWindows = useCallback(() => {
    if (!windowNavigation?.reload || windowNavigation.loading) return;
    haptic();
    windowNavigation.reload();
  }, [haptic, windowNavigation]);

  const selectPage = useCallback(
    (index: number) => {
      haptic();
      setCurrentPage(index);
      carouselApi?.scrollTo(index);
    },
    [carouselApi, haptic],
  );

  const previousDisabledReason = getWindowStepDisabledReason("previous", windowNavigation);
  const nextDisabledReason = getWindowStepDisabledReason("next", windowNavigation);
  const windowStatus = getWindowNavigationStatus(windowNavigation);
  const windowSwitcherDisabled = !windowNavigation?.onOpenSwitcher || windowNavigation.loading;
  const windowSwitcherDisabledReason = !windowNavigation?.onOpenSwitcher
    ? "Terminal window switcher unavailable"
    : windowNavigation.loading
      ? "Loading terminal windows"
      : undefined;
  const reloadDisabled = !windowNavigation?.reload || Boolean(windowNavigation.loading);
  const reloadLabel = windowNavigation?.error ? "Retry" : "Reload";

  useEffect(() => {
    if (!carouselApi) return;

    const syncCurrentPage = () => {
      setCurrentPage(carouselApi.selectedScrollSnap());
    };

    syncCurrentPage();
    carouselApi.on("select", syncCurrentPage);
    carouselApi.on("reInit", syncCurrentPage);

    return () => {
      carouselApi.off("select", syncCurrentPage);
      carouselApi.off("reInit", syncCurrentPage);
    };
  }, [carouselApi]);

  return (
    <section
      aria-label="Terminal mobile controls"
      className={cn(
        "flex shrink-0 flex-col border-t bg-background/95 px-2 pt-2 backdrop-blur supports-[backdrop-filter]:bg-background/85",
        isKeyboardVisible ? "pb-0" : "pb-[max(1rem,var(--safe-area-inset-bottom))]",
      )}
      data-sidebar-gesture-ignore="true"
      style={{
        touchAction: "manipulation",
        ...NO_TOUCH_STYLE,
      }}
    >
      <Carousel
        aria-label="Terminal controls carousel"
        className={cn("mt-0", isKeyboardVisible ? "order-2" : "order-1")}
        data-sidebar-gesture-ignore="true"
        opts={{ align: "start", containScroll: "trimSnaps" }}
        setApi={setCarouselApi}
      >
        <CarouselContent className="-ml-2">
          <CarouselItem aria-label="Key controls" className="pl-2">
            <ButtonGroup
              aria-label="Terminal quick actions"
              className="grid w-full grid-cols-4 rounded-none"
            >
              {QUICK_ROW_KEYS.map(({ label, icon: Icon, sequence }) => (
                <Button
                  key={label}
                  type="button"
                  variant="outline"
                  className={STACKED_BUTTON_CLASS}
                  style={NO_TOUCH_STYLE}
                  onPointerDown={keepTerminalKeyboardOpen}
                  onMouseDown={keepTerminalKeyboardOpen}
                  onClick={() => sendKey(sequence)}
                >
                  <MobileControlButtonContent Icon={Icon} label={label} />
                </Button>
              ))}
            </ButtonGroup>
          </CarouselItem>

          <CarouselItem aria-label="Navigation controls" className="pl-2">
            <ButtonGroup
              aria-label="Terminal navigation keys"
              className="grid w-full grid-cols-4 rounded-none"
            >
              {NAVIGATION_KEYS.map(({ label, icon: Icon, sequence }) => (
                <Button
                  key={label}
                  type="button"
                  variant="outline"
                  className={STACKED_BUTTON_CLASS}
                  style={NO_TOUCH_STYLE}
                  onPointerDown={keepTerminalKeyboardOpen}
                  onMouseDown={keepTerminalKeyboardOpen}
                  onClick={() => sendKey(sequence)}
                >
                  <MobileControlButtonContent Icon={Icon} label={label} />
                </Button>
              ))}
            </ButtonGroup>
          </CarouselItem>

          <CarouselItem aria-label="Windows controls" className="pl-2">
            <div className="flex flex-col gap-1">
              <ButtonGroup
                aria-label="Terminal window controls"
                className="grid w-full grid-cols-4 rounded-none"
              >
                <Button
                  type="button"
                  variant="outline"
                  className={STACKED_BUTTON_CLASS}
                  style={NO_TOUCH_STYLE}
                  onPointerDown={keepTerminalKeyboardOpen}
                  onMouseDown={keepTerminalKeyboardOpen}
                  onClick={() => switchWindow(windowNavigation?.previous)}
                  disabled={Boolean(previousDisabledReason)}
                  aria-label="Switch to previous terminal window"
                  aria-describedby="terminal-window-navigation-status"
                  title={previousDisabledReason}
                >
                  <MobileControlButtonContent Icon={ArrowLeft} label="Previous" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={STACKED_BUTTON_CLASS}
                  style={NO_TOUCH_STYLE}
                  onPointerDown={keepTerminalKeyboardOpen}
                  onMouseDown={keepTerminalKeyboardOpen}
                  onClick={openWindowSwitcher}
                  disabled={windowSwitcherDisabled}
                  aria-label="Open terminal window switcher"
                  aria-describedby="terminal-window-navigation-status"
                  title={windowSwitcherDisabledReason}
                >
                  <MobileControlButtonContent Icon={List} label="Windows" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={STACKED_BUTTON_CLASS}
                  style={NO_TOUCH_STYLE}
                  onPointerDown={keepTerminalKeyboardOpen}
                  onMouseDown={keepTerminalKeyboardOpen}
                  onClick={() => switchWindow(windowNavigation?.next)}
                  disabled={Boolean(nextDisabledReason)}
                  aria-label="Switch to next terminal window"
                  aria-describedby="terminal-window-navigation-status"
                  title={nextDisabledReason}
                >
                  <MobileControlButtonContent Icon={ArrowRight} label="Next" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={STACKED_BUTTON_CLASS}
                  style={NO_TOUCH_STYLE}
                  onPointerDown={keepTerminalKeyboardOpen}
                  onMouseDown={keepTerminalKeyboardOpen}
                  onClick={reloadWindows}
                  disabled={reloadDisabled}
                  aria-label={
                    windowNavigation?.error
                      ? "Retry loading terminal windows"
                      : "Reload terminal window list"
                  }
                  aria-describedby="terminal-window-navigation-status"
                >
                  <MobileControlButtonContent Icon={RefreshCw} label={reloadLabel} />
                </Button>
              </ButtonGroup>
              <p
                id="terminal-window-navigation-status"
                aria-live="polite"
                className="min-h-4 truncate text-center text-[11px] text-muted-foreground"
              >
                {windowStatus}
              </p>
            </div>
          </CarouselItem>

          <CarouselItem aria-label="Compose controls" className="pl-2">
            <ButtonGroup aria-label="Terminal compose controls" className="w-full rounded-none">
              <Button
                type="button"
                variant="outline"
                className="min-h-14 w-full flex-col gap-1 px-1 py-2 text-xs leading-none"
                style={NO_TOUCH_STYLE}
                onPointerDown={keepTerminalKeyboardOpen}
                onMouseDown={keepTerminalKeyboardOpen}
                onClick={openCompose}
              >
                <MobileControlButtonContent Icon={MessageSquareText} label="Compose" />
              </Button>
            </ButtonGroup>
          </CarouselItem>

          <CarouselItem aria-label="Font size controls" className="pl-2">
            <ButtonGroup aria-label="Terminal font size controls" className="w-full rounded-none">
              <Button
                type="button"
                variant="outline"
                className="min-h-14 min-w-0 flex-1 flex-col gap-1 px-1 py-2 text-xs leading-none"
                style={NO_TOUCH_STYLE}
                onPointerDown={keepTerminalKeyboardOpen}
                onMouseDown={keepTerminalKeyboardOpen}
                onClick={decreaseFontSize}
                disabled={!canDecrease}
                aria-label="Decrease font size"
              >
                <MobileControlButtonContent Icon={Minus} label="Smaller" />
              </Button>
              <ButtonGroupText className="min-h-14 flex-1 justify-center tabular-nums">
                {fontSize}px
              </ButtonGroupText>
              <Button
                type="button"
                variant="outline"
                className="min-h-14 min-w-0 flex-1 flex-col gap-1 px-1 py-2 text-xs leading-none"
                style={NO_TOUCH_STYLE}
                onPointerDown={keepTerminalKeyboardOpen}
                onMouseDown={keepTerminalKeyboardOpen}
                onClick={increaseFontSize}
                disabled={!canIncrease}
                aria-label="Increase font size"
              >
                <MobileControlButtonContent Icon={Plus} label="Larger" />
              </Button>
            </ButtonGroup>
          </CarouselItem>
        </CarouselContent>
      </Carousel>

      <nav
        aria-label="Terminal control pages"
        className={cn(
          "flex items-center justify-center gap-1",
          isKeyboardVisible ? "order-1 mb-1 h-4" : "order-2 mt-0.5 h-4",
        )}
      >
        {CONTROL_PAGES.map((label, index) => (
          <button
            key={label}
            type="button"
            aria-current={currentPage === index ? "page" : undefined}
            aria-label={`Show ${label} controls`}
            className="relative flex h-4 w-5 items-center justify-center rounded-full before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']"
            style={NO_TOUCH_STYLE}
            onPointerDown={keepTerminalKeyboardOpen}
            onMouseDown={keepTerminalKeyboardOpen}
            onClick={() => selectPage(index)}
          >
            <span
              className={cn(
                "block h-1.5 rounded-full transition-[width,background-color,opacity] duration-200 ease-out",
                currentPage === index
                  ? "w-4 bg-foreground opacity-80"
                  : "w-1.5 bg-muted-foreground/40 opacity-70",
              )}
            />
          </button>
        ))}
      </nav>
    </section>
  );
}
