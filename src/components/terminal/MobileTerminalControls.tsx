"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Ellipsis,
  Keyboard,
  MessageSquareText,
  Minus,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, PointerEvent } from "react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";
import { VIRTUAL_KEY_SEQUENCES } from "@/lib/terminal/virtual-keys";

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

export interface MobileTerminalControlsProps {
  /** Called once for each terminal action press and More toggle. */
  onHapticFeedback?: () => void;
}

export function MobileTerminalControls({ onHapticFeedback }: MobileTerminalControlsProps = {}) {
  const { activeSend } = useKeybindings();
  const [expanded, setExpanded] = useState(false);
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

  const handleMoreOpenChange = useCallback(
    (open: boolean) => {
      haptic();
      setExpanded(open);
    },
    [haptic],
  );

  return (
    <Collapsible open={expanded} onOpenChange={handleMoreOpenChange}>
      <section
        aria-label="Terminal mobile controls"
        className="shrink-0 rounded-2xl border bg-background/95 p-2 shadow-[0_-12px_32px_rgba(0,0,0,0.16)] backdrop-blur supports-[backdrop-filter]:bg-background/85"
        style={{
          touchAction: "manipulation",
          ...NO_TOUCH_STYLE,
        }}
      >
        <CollapsibleContent
          role="region"
          aria-label="More terminal actions"
          className="overflow-hidden rounded-xl border bg-popover/90 text-popover-foreground data-ending-style:max-h-0 data-starting-style:max-h-0"
        >
          <div className="flex max-h-[min(42dvh,22rem)] w-full flex-col gap-3 overflow-y-auto p-2">
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

            <section aria-label="Navigation keys" className="flex flex-col gap-2">
              <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Navigation
              </p>
              <ButtonGroup
                aria-label="Terminal navigation keys"
                className="grid w-full grid-cols-5"
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
            </section>

            <section aria-label="Terminal font size" className="flex flex-col gap-2">
              <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Font size
              </p>
              <ButtonGroup aria-label="Terminal font size controls" className="w-full">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 min-w-11 flex-1"
                  style={NO_TOUCH_STYLE}
                  onPointerDown={keepTerminalKeyboardOpen}
                  onMouseDown={keepTerminalKeyboardOpen}
                  onClick={decreaseFontSize}
                  disabled={!canDecrease}
                  aria-label="Decrease font size"
                >
                  <Minus />
                </Button>
                <ButtonGroupText className="min-h-11 flex-1 justify-center tabular-nums">
                  {fontSize}px
                </ButtonGroupText>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 min-w-11 flex-1"
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
            </section>
          </div>
        </CollapsibleContent>

        <ButtonGroup
          aria-label="Terminal quick actions"
          className="mt-2 grid w-full grid-cols-4 rounded-xl border bg-background/95 p-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80"
        >
          {QUICK_ROW_KEYS.map(({ label, icon: Icon, sequence }) => (
            <Button
              key={label}
              type="button"
              variant="ghost"
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
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant={expanded ? "secondary" : "default"}
                className="min-h-12 min-w-0 rounded-lg px-1 text-xs"
                style={NO_TOUCH_STYLE}
                onPointerDown={keepTerminalKeyboardOpen}
                onMouseDown={keepTerminalKeyboardOpen}
              />
            }
          >
            <Ellipsis data-icon="inline-start" />
            More
          </CollapsibleTrigger>
        </ButtonGroup>
      </section>
    </Collapsible>
  );
}
