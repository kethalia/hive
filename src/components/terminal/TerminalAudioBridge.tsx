"use client";

import { useEffect, useRef, useState } from "react";
import { TerminalAudio, type TerminalAudioStatus } from "@/lib/terminal/browser-audio";

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
    const audio = new TerminalAudio(`${proxyUrl}/ws/audio?${params}`, setStatus);
    let inView = false;
    const update = () =>
      audio.setVisible(
        inView && document.visibilityState === "visible" && !terminal.closest("[inert]"),
      );
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    observer.observe(terminal);
    // Persistent terminal surfaces can be parked without unmounting.
    const parking = new MutationObserver(update);
    parking.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert"] });
    const prime = (event: KeyboardEvent) => {
      if (event.key === "Enter") audio.prime();
    };
    terminal.addEventListener("keydown", prime, { capture: true });
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      parking.disconnect();
      terminal.removeEventListener("keydown", prime, { capture: true });
      document.removeEventListener("visibilitychange", update);
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
