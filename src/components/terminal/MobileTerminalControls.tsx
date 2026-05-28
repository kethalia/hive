"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Keyboard,
  MessageSquareText,
  Minus,
  Plus,
  Terminal,
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
  { label: "Esc", icon: Terminal, sequence: VIRTUAL_KEY_SEQUENCES.Esc },
] as const;

const QUICK_ROW_KEYS = [
  { label: "Enter", icon: CornerDownLeft, sequence: VIRTUAL_KEY_SEQUENCES.Enter },
  { label: "Tab", icon: Keyboard, sequence: VIRTUAL_KEY_SEQUENCES.Tab },
  { label: "Ctrl+C", icon: X, sequence: VIRTUAL_KEY_SEQUENCES.CtrlC },
] as const;

const CONTROL_PAGES = ["Compose", "Navigation", "Font size"] as const;

export interface MobileTerminalControlsProps {
  /** Called once for each terminal action press and page-dot navigation. */
  onHapticFeedback?: () => void;
}

export function MobileTerminalControls({ onHapticFeedback }: MobileTerminalControlsProps = {}) {
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

  const selectPage = useCallback(
    (index: number) => {
      haptic();
      setCurrentPage(index);
      carouselApi?.scrollTo(index);
    },
    [carouselApi, haptic],
  );

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
      className="shrink-0 border-t bg-background/95 px-2 pt-2 pb-1 backdrop-blur supports-[backdrop-filter]:bg-background/85"
      style={{
        touchAction: "manipulation",
        ...NO_TOUCH_STYLE,
      }}
    >
      <ButtonGroup
        aria-label="Terminal quick actions"
        className="grid w-full grid-cols-3 gap-1 rounded-none"
      >
        {QUICK_ROW_KEYS.map(({ label, icon: Icon, sequence }) => (
          <Button
            key={label}
            type="button"
            variant="outline"
            className="min-h-12 min-w-0 rounded-lg px-1 text-xs"
            style={NO_TOUCH_STYLE}
            onPointerDown={keepTerminalKeyboardOpen}
            onMouseDown={keepTerminalKeyboardOpen}
            onClick={() => sendKey(sequence)}
          >
            <Icon data-icon="inline-start" />
            {label}
          </Button>
        ))}
      </ButtonGroup>

      <nav
        aria-label="Terminal control pages"
        className="mt-1 flex items-center justify-center gap-1"
      >
        {CONTROL_PAGES.map((label, index) => (
          <button
            key={label}
            type="button"
            aria-current={currentPage === index ? "page" : undefined}
            aria-label={`Show ${label} controls`}
            className="flex size-6 items-center justify-center rounded-full"
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

      <Carousel
        aria-label="Terminal secondary controls"
        className="mt-1"
        opts={{ align: "start", containScroll: "trimSnaps" }}
        setApi={setCarouselApi}
      >
        <CarouselContent className="-ml-2">
          <CarouselItem aria-label="Compose controls" className="pl-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full justify-start rounded-xl"
              style={NO_TOUCH_STYLE}
              onPointerDown={keepTerminalKeyboardOpen}
              onMouseDown={keepTerminalKeyboardOpen}
              onClick={openCompose}
            >
              <MessageSquareText data-icon="inline-start" />
              Compose
            </Button>
          </CarouselItem>

          <CarouselItem aria-label="Navigation controls" className="pl-2">
            <ButtonGroup
              aria-label="Terminal navigation keys"
              className="grid w-full grid-cols-5 gap-1"
            >
              {NAVIGATION_KEYS.map(({ label, icon: Icon, sequence }) => (
                <Button
                  key={label}
                  type="button"
                  variant="outline"
                  className="min-h-11 min-w-11 flex-col gap-1 rounded-xl px-2 py-2 text-xs"
                  style={NO_TOUCH_STYLE}
                  onPointerDown={keepTerminalKeyboardOpen}
                  onMouseDown={keepTerminalKeyboardOpen}
                  onClick={() => sendKey(sequence)}
                >
                  <Icon />
                  <span>{label}</span>
                </Button>
              ))}
            </ButtonGroup>
          </CarouselItem>

          <CarouselItem aria-label="Font size controls" className="pl-2">
            <ButtonGroup aria-label="Terminal font size controls" className="w-full gap-1">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 min-w-11 flex-1 rounded-xl"
                style={NO_TOUCH_STYLE}
                onPointerDown={keepTerminalKeyboardOpen}
                onMouseDown={keepTerminalKeyboardOpen}
                onClick={decreaseFontSize}
                disabled={!canDecrease}
                aria-label="Decrease font size"
              >
                <Minus />
              </Button>
              <ButtonGroupText className="min-h-11 flex-1 justify-center rounded-xl tabular-nums">
                {fontSize}px
              </ButtonGroupText>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 min-w-11 flex-1 rounded-xl"
                style={NO_TOUCH_STYLE}
                onPointerDown={keepTerminalKeyboardOpen}
                onMouseDown={keepTerminalKeyboardOpen}
                onClick={increaseFontSize}
                disabled={!canIncrease}
                aria-label="Increase font size"
              >
                <Plus />
              </Button>
            </ButtonGroup>
          </CarouselItem>
        </CarouselContent>
      </Carousel>
    </section>
  );
}
