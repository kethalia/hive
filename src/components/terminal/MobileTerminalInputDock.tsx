"use client";

import { CornerDownLeft, Send } from "lucide-react";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { useKeybindings } from "@/hooks/useKeybindings";
import { NO_TOUCH_STYLE } from "@/lib/gestures/conventions";

export function MobileTerminalInputDock() {
  const { activeSend } = useKeybindings();
  const [draft, setDraft] = useState("");

  const keepInputFocused = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement> | ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const sendDraft = useCallback(() => {
    if (!activeSend || draft.length === 0) return;
    activeSend(draft);
    activeSend("\r");
    setDraft("");
  }, [activeSend, draft]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      sendDraft();
    },
    [sendDraft],
  );

  return (
    <form
      aria-label="Terminal command input"
      className="shrink-0 border-t bg-background/95 px-2 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85"
      data-sidebar-gesture-ignore="true"
      data-testid="mobile-terminal-input-dock"
      onSubmit={handleSubmit}
    >
      <div className="flex items-center gap-2">
        <label htmlFor="mobile-terminal-command" className="sr-only">
          Type terminal command
        </label>
        <input
          id="mobile-terminal-command"
          className="min-h-12 min-w-0 flex-1 rounded-md border bg-[#0a0a0a] px-3 font-mono text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          type="text"
          inputMode="text"
          enterKeyHint="send"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Type command…"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
        />
        <ButtonGroup aria-label="Terminal input actions" className="shrink-0 rounded-none">
          <Button
            type="submit"
            className="min-h-12 px-3"
            disabled={!activeSend || draft.length === 0}
            aria-label="Send command"
            style={NO_TOUCH_STYLE}
            onPointerDown={keepInputFocused}
            onMouseDown={keepInputFocused}
          >
            <Send />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-12 px-3"
            disabled={!activeSend}
            aria-label="Send Enter"
            style={NO_TOUCH_STYLE}
            onPointerDown={keepInputFocused}
            onMouseDown={keepInputFocused}
            onClick={() => activeSend?.("\r")}
          >
            <CornerDownLeft />
          </Button>
        </ButtonGroup>
      </div>
    </form>
  );
}
