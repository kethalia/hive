"use client";

import { useEffect, useRef, useState } from "react";
import { TerminalAudio, type TerminalAudioStatus } from "@/lib/terminal/browser-audio";
import { TERMINAL_AUDIO_PRIME_EVENT } from "@/lib/terminal/events";

export function TerminalAudioBridge({
  proxyUrl,
  workspaceId,
  agentId,
  sessionName,
}: {
  proxyUrl: string;
  workspaceId: string;
  agentId: string;
  sessionName: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalAudioStatus>({ phase: "standby" });
  useEffect(() => {
    if (!proxyUrl || !element.current) return;
    const terminal = element.current.closest<HTMLElement>('[data-terminal-surface="true"]');
    if (!terminal) return;
    const params = new URLSearchParams({ workspaceId, agentId, sessionName });
    let lastInteractionAt = Number.NEGATIVE_INFINITY;
    const audio = new TerminalAudio(
      `${proxyUrl}/ws/audio?${params}`,
      setStatus,
      () => {
        if (!document.hasFocus()) return false;
        const focusedTerminal = document.activeElement?.closest('[data-terminal-surface="true"]');
        if (focusedTerminal) return focusedTerminal === terminal;
        // Touch/Compose input may live outside xterm; use the selected pane then.
        return terminal.closest("[data-pane-mode]")?.getAttribute("data-active") !== "false";
      },
      () => Date.now() - lastInteractionAt < 15_000,
    );
    let inView = false;
    const update = () => {
      audio.setVisible(
        inView && document.visibilityState === "visible" && !terminal.closest("[inert]"),
      );
      audio.refreshFocus();
    };
    // focusout briefly exposes body as activeElement. Read the settled focus so
    // selecting another pane does not claim/release relays midway through focus.
    const focus = () => queueMicrotask(update);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    observer.observe(terminal);
    // Persistent terminal surfaces can be parked without unmounting.
    const parking = new MutationObserver(update);
    parking.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["inert", "data-active"],
    });
    const prime = () => {
      lastInteractionAt = Date.now();
      audio.prime();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Enter") prime();
    };
    terminal.addEventListener("keydown", keydown, { capture: true });
    terminal.addEventListener(TERMINAL_AUDIO_PRIME_EVENT, prime);
    document.addEventListener("visibilitychange", update);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focus);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", focus);
    return () => {
      observer.disconnect();
      parking.disconnect();
      terminal.removeEventListener("keydown", keydown, { capture: true });
      terminal.removeEventListener(TERMINAL_AUDIO_PRIME_EVENT, prime);
      document.removeEventListener("visibilitychange", update);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", focus);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
      audio.dispose();
    };
  }, [proxyUrl, workspaceId, agentId, sessionName]);

  return (
    <div
      ref={element}
      className="pointer-events-none absolute right-2 top-2 z-10 max-w-[min(90%,32rem)]"
    >
      {status.phase !== "standby" ? (
        <div
          role="status"
          aria-live="polite"
          className={`rounded bg-background/95 px-2 py-1 text-xs ${status.phase === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {status.message}
        </div>
      ) : null}
    </div>
  );
}
