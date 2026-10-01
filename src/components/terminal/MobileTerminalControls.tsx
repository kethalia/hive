"use client";

import { ClipboardPaste, Copy, MessageSquareText, Minus, Plus } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";
import {
  getMobileModifiers,
  NO_MOBILE_MODIFIERS,
  setMobileModifiers,
  subscribeMobileModifiers,
} from "@/lib/terminal/mobile-modifiers";
import { MOBILE_SMART_KEYS } from "@/lib/terminal/mobile-smart-keys";
import { encodeTerminalShortcut } from "@/lib/terminal/shortcut-keys";
import { cn } from "@/lib/utils";

const ARROW_LABELS: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→" };
const BUTTON_CLASS = "h-9 min-w-9 shrink-0 px-2 text-xs font-mono";

interface MobileTerminalWindowSession {
  id?: string;
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
  select?: (sessionId: string) => boolean | undefined;
  reload?: () => void;
  onOpenSwitcher?: () => void;
}

export interface MobileTerminalControlsProps {
  isKeyboardVisible?: boolean;
  /** Called once for each terminal action press. */
  onHapticFeedback?: () => void;
  windowNavigation?: MobileTerminalWindowNavigation;
  hasSelection?: boolean;
  onCopy?: () => void;
  onPaste?: () => void;
  clipboardStatusText?: string;
  copyDisabledReason?: string;
  pasteDisabledReason?: string;
}

export function MobileTerminalControls({
  isKeyboardVisible = false,
  onHapticFeedback,
  hasSelection = false,
  onCopy,
  onPaste,
  clipboardStatusText,
  copyDisabledReason,
  pasteDisabledReason,
}: MobileTerminalControlsProps = {}) {
  const { activeSend, activeTerminal } = useKeybindings();
  const modifiers = useSyncExternalStore(
    subscribeMobileModifiers,
    () => getMobileModifiers(activeTerminal),
    () => NO_MOBILE_MODIFIERS,
  );
  useEffect(() => () => setMobileModifiers(activeTerminal, NO_MOBILE_MODIFIERS), [activeTerminal]);
  const { increase, decrease, canIncrease, canDecrease } = useTerminalFontStep();
  const press = (action: () => void) => {
    onHapticFeedback?.();
    action();
  };
  const prefix = `${modifiers.ctrl ? "Ctrl+" : ""}${modifiers.alt ? "Alt+" : ""}${modifiers.shift ? "Shift+" : ""}`;
  const seenSequences = new Set<string>();
  const keys = MOBILE_SMART_KEYS.flatMap(({ label, sequence }) => {
    const fixedCombination = label.length > 1 && label.includes("+");
    const output = fixedCombination ? sequence : encodeTerminalShortcut(label, modifiers);
    if (seenSequences.has(output)) return [];
    seenSequences.add(output);
    return [
      {
        id: label,
        display: ARROW_LABELS[label] ? `${prefix}${ARROW_LABELS[label]}` : undefined,
        label: fixedCombination
          ? label
          : `${prefix}${prefix && label.length === 1 ? label.toUpperCase() : label}`,
        sequence: output,
      },
    ];
  });
  return (
    <section
      aria-label="Terminal mobile controls"
      className={cn(
        "min-w-0 shrink-0 border-t bg-background/95 px-2 pt-1",
        isKeyboardVisible ? "pb-0" : "pb-[max(0.25rem,var(--safe-area-inset-bottom))]",
      )}
      data-sidebar-gesture-ignore="true"
    >
      <fieldset
        aria-label="Terminal keys"
        data-mobile-scroll-allow="true"
        className="min-w-0 flex flex-nowrap gap-1 overflow-x-auto overscroll-x-contain py-1"
        style={{ touchAction: "pan-x" }}
        onMouseDown={(event) => event.preventDefault()}
      >
        {(["ctrl", "alt", "shift"] as const).map((modifier) => (
          <Button
            key={modifier}
            type="button"
            variant={modifiers[modifier] ? "default" : "outline"}
            className={cn(BUTTON_CLASS, modifiers[modifier] && "ring-2 ring-primary ring-offset-1")}
            disabled={!activeSend || !activeTerminal}
            aria-pressed={modifiers[modifier]}
            onClick={() =>
              press(() =>
                setMobileModifiers(activeTerminal, {
                  ...modifiers,
                  [modifier]: !modifiers[modifier],
                }),
              )
            }
          >
            {modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift"}
          </Button>
        ))}
        {keys.map(({ id, label, sequence, display }) => (
          <Button
            key={id}
            aria-label={label}
            type="button"
            variant="outline"
            className={BUTTON_CLASS}
            disabled={!activeSend}
            onClick={() =>
              press(() => {
                activeSend?.(sequence);
                setMobileModifiers(activeTerminal, NO_MOBILE_MODIFIERS);
              })
            }
          >
            {display ?? label}
          </Button>
        ))}
        {[
          {
            label: "Copy terminal selection",
            Icon: Copy,
            action: () => onCopy?.(),
            disabled: !onCopy || !hasSelection || Boolean(copyDisabledReason),
          },
          {
            label: "Paste from clipboard",
            Icon: ClipboardPaste,
            action: () => onPaste?.(),
            disabled: !onPaste || Boolean(pasteDisabledReason),
          },
          {
            label: "Compose",
            Icon: MessageSquareText,
            action: () => window.dispatchEvent(new CustomEvent(TERMINAL_COMPOSE_OPEN_EVENT)),
          },
          { label: "Decrease font size", Icon: Minus, action: decrease, disabled: !canDecrease },
          { label: "Increase font size", Icon: Plus, action: increase, disabled: !canIncrease },
        ].map(({ label, Icon, action, disabled }) => (
          <Button
            key={label}
            type="button"
            variant="outline"
            className={BUTTON_CLASS}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => press(action)}
          >
            <Icon aria-hidden="true" className="size-4" />
          </Button>
        ))}
      </fieldset>
      <span className="sr-only" aria-live="polite">
        {clipboardStatusText}
      </span>
    </section>
  );
}
