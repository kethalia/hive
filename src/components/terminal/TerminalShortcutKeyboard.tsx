"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  encodeTerminalShortcut,
  TERMINAL_SHORTCUT_KEYS,
  type TerminalKeyModifiers,
} from "@/lib/terminal/shortcut-keys";

const NO_MODIFIERS: TerminalKeyModifiers = { ctrl: false, alt: false, shift: false };

export function TerminalShortcutKeyboard({
  send,
  onPress,
  onPaste,
  onCopy,
}: {
  send: ((sequence: string) => void) | null;
  onPress?: () => void;
  onPaste?: () => void;
  onCopy?: () => void;
}) {
  const [modifiers, setModifiers] = useState(NO_MODIFIERS);
  return (
    <details className="w-full">
      <summary className="cursor-pointer py-3 text-center text-sm">All shortcut keys</summary>
      <p className="mb-2 text-center text-xs text-muted-foreground">
        Choose modifiers, then a key. Uses your active Codex keymap.
      </p>
      <fieldset className="mb-2 flex justify-center gap-2" aria-label="Shortcut modifiers">
        {(["ctrl", "alt", "shift"] as const).map((modifier) => (
          <Button
            key={modifier}
            variant="outline"
            aria-pressed={modifiers[modifier]}
            disabled={!send}
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              setModifiers((current) => ({ ...current, [modifier]: !current[modifier] }))
            }
          >
            {modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift"}
          </Button>
        ))}
      </fieldset>
      <fieldset
        className="grid max-h-48 grid-cols-6 gap-1 overflow-y-auto"
        aria-label="All terminal keys"
      >
        {TERMINAL_SHORTCUT_KEYS.map((key) => (
          <Button
            key={key}
            aria-label={`Key ${key}`}
            variant="outline"
            className="min-h-11 px-1 text-xs"
            disabled={!send}
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!send) return;
              onPress?.();
              if (modifiers.ctrl && !modifiers.alt && key === "v" && onPaste) onPaste();
              else if (modifiers.ctrl && !modifiers.alt && key === "c" && onCopy) onCopy();
              else send(encodeTerminalShortcut(key, modifiers));
              setModifiers(NO_MODIFIERS);
            }}
          >
            {key}
          </Button>
        ))}
      </fieldset>
    </details>
  );
}
