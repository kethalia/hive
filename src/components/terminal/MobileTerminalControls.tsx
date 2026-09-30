"use client";

import { ClipboardPaste, Copy, MessageSquareText, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";
import { MOBILE_SMART_KEYS } from "@/lib/terminal/mobile-smart-keys";
import {
  encodeTerminalShortcut,
  TERMINAL_SHORTCUT_KEYS,
  type TerminalKeyModifiers,
} from "@/lib/terminal/shortcut-keys";
import { cn } from "@/lib/utils";

const NO_MODIFIERS: TerminalKeyModifiers = { ctrl: false, alt: false, shift: false };
const EXTRA_KEYS = TERMINAL_SHORTCUT_KEYS.filter(
  (key) => !MOBILE_SMART_KEYS.some((item) => item.label === key),
);
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
  const { activeSend } = useKeybindings();
  const [modifiers, setModifiers] = useState(NO_MODIFIERS);
  const { increase, decrease, canIncrease, canDecrease } = useTerminalFontStep();
  const press = (action: () => void) => {
    onHapticFeedback?.();
    action();
  };
  const prefix = `${modifiers.ctrl ? "Ctrl+" : ""}${modifiers.alt ? "Alt+" : ""}${modifiers.shift ? "Shift+" : ""}`;
  const seenSequences = new Set<string>();
  const keys = [
    ...MOBILE_SMART_KEYS,
    ...EXTRA_KEYS.map((label) => ({
      label,
      sequence: encodeTerminalShortcut(label, NO_MODIFIERS),
    })),
  ].flatMap(({ label, sequence }) => {
    const fixedCombination = label.length > 1 && label.includes("+");
    const output = fixedCombination ? sequence : encodeTerminalShortcut(label, modifiers);
    if (seenSequences.has(output)) return [];
    seenSequences.add(output);
    return [
      {
        id: label,
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
            variant="outline"
            className={BUTTON_CLASS}
            disabled={!activeSend}
            aria-pressed={modifiers[modifier]}
            onClick={() =>
              press(() =>
                setModifiers((current) => ({ ...current, [modifier]: !current[modifier] })),
              )
            }
          >
            {modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift"}
          </Button>
        ))}
        {keys.map(({ id, label, sequence }) => (
          <Button
            key={id}
            type="button"
            variant="outline"
            className={BUTTON_CLASS}
            disabled={!activeSend}
            onClick={() =>
              press(() => {
                activeSend?.(sequence);
                setModifiers(NO_MODIFIERS);
              })
            }
          >
            {label}
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
