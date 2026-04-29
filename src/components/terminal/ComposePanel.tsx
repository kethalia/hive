"use client";

import { useCallback, useRef } from "react";
import { Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useKeybindings } from "@/hooks/useKeybindings";

interface ComposePanelProps {
  onClose: () => void;
}

export function ComposePanel({ onClose }: ComposePanelProps) {
  const { activeSend } = useKeybindings();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sendComposed = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || !textarea.value || !activeSend) return;
    activeSend(textarea.value);
    activeSend("\r");
    textarea.value = "";
    textarea.focus();
  }, [activeSend]);

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
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <span className="text-xs font-medium text-muted-foreground">
          Compose — Ctrl+Enter to send
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={onClose}
          aria-label="Close compose panel"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative flex-1">
        <textarea
          ref={textareaRef}
          className="h-full w-full resize-none bg-[#0a0a0a] p-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          placeholder="Type multi-line command..."
          autoFocus
          onKeyDown={handleKeyDown}
        />
        <Button
          size="sm"
          className="absolute bottom-2 right-2 gap-1.5"
          onClick={sendComposed}
          disabled={!activeSend}
          aria-label="Send command"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </Button>
      </div>
    </div>
  );
}
