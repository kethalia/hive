"use client";

import { Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { useKeybindings } from "@/hooks/useKeybindings";
import { formatShortcut } from "@/lib/keyboard-shortcuts";

interface ComposePanelProps {
  onClose: () => void;
  hideHeader?: boolean;
  initialDraft?: string;
  targetLabel?: string;
  onSend?: (draft: string) => void;
}

const SEND_COMPOSE_SHORTCUT_KEYS = ["ctrl+enter", "cmd+enter"] as const;

export function ComposePanel({
  onClose,
  hideHeader = false,
  initialDraft = "",
  targetLabel,
  onSend,
}: ComposePanelProps) {
  const { activeSend } = useKeybindings();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(initialDraft);
  const previousInitialDraftRef = useRef(initialDraft);

  const sendComposed = useCallback(() => {
    if (!draft) return;
    if (onSend) {
      onSend(draft);
    } else if (activeSend) {
      activeSend(draft);
      activeSend("\r");
    } else {
      return;
    }
    setDraft("");
    onClose();
  }, [activeSend, draft, onClose, onSend]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (previousInitialDraftRef.current === initialDraft) return;
    previousInitialDraftRef.current = initialDraft;
    setDraft(initialDraft);
  }, [initialDraft]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        sendComposed();
      }
      e.stopPropagation();
    },
    [sendComposed],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      {!hideHeader && (
        <div className="flex items-center border-b border-border px-3 py-1">
          <span className="text-xs font-medium text-muted-foreground">
            Compose{targetLabel ? ` to ${targetLabel}` : ""} —{" "}
            {formatShortcut(SEND_COMPOSE_SHORTCUT_KEYS)} to send
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <textarea
          ref={textareaRef}
          className="h-full w-full resize-none bg-[#0a0a0a] p-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          placeholder="Type multi-line command..."
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className="border-t border-border p-3">
        <ButtonGroup aria-label="Compose actions" className="w-full rounded-none">
          <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11 flex-1"
            onClick={sendComposed}
            disabled={!(onSend || activeSend) || !draft}
            aria-label="Send command"
          >
            <Send data-icon="inline-start" />
            Send
          </Button>
        </ButtonGroup>
      </div>
    </div>
  );
}
