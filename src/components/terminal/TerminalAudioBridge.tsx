"use client";

import { useEffect, useRef, useState } from "react";
import { terminalAuthProtocols } from "@/lib/terminal/auth-transport";
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
  const controller = useRef<TerminalAudio | null>(null);
  const [status, setStatus] = useState<TerminalAudioStatus>({ phase: "standby" });
  useEffect(() => {
    setStatus({ phase: "standby" });
    if (!proxyUrl || !element.current) return;
    const terminal = element.current.closest<HTMLElement>('[data-terminal-surface="true"]');
    if (!terminal) return;
    const params = new URLSearchParams({ workspaceId, agentId, sessionName });
    const audio = new TerminalAudio(
      `${proxyUrl}/ws/audio?${params}`,
      setStatus,
      () => {
        if (!document.hasFocus()) return false;
        // Selection can settle before xterm moves its keyboard focus.
        if (terminal.closest("[data-pane-mode]")?.getAttribute("data-active") === "false")
          return false;
        const focusedTerminal = document.activeElement?.closest('[data-terminal-surface="true"]');
        if (focusedTerminal) return focusedTerminal === terminal;
        // Touch input may live outside xterm; use the selected pane then.
        return true;
      },
      (url) => terminalAuthProtocols(url, "hive-audio-v1"),
    );
    controller.current = audio;
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
    const prime = () => audio.prime();
    const freeze = () => audio.setFrozen(true);
    const resume = () => {
      audio.setFrozen(false);
      update();
    };
    terminal.addEventListener(TERMINAL_AUDIO_PRIME_EVENT, prime);
    document.addEventListener("visibilitychange", update);
    document.addEventListener("freeze", freeze);
    document.addEventListener("resume", resume);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focus);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", focus);
    return () => {
      observer.disconnect();
      parking.disconnect();
      terminal.removeEventListener(TERMINAL_AUDIO_PRIME_EVENT, prime);
      document.removeEventListener("visibilitychange", update);
      document.removeEventListener("freeze", freeze);
      document.removeEventListener("resume", resume);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", focus);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
      audio.dispose();
      if (controller.current === audio) controller.current = null;
    };
  }, [proxyUrl, workspaceId, agentId, sessionName]);

  // Bind controls to the rendered controller/request, including across prop
  // changes. A queued click must not approve a replacement terminal or call.
  const audio = controller.current;
  return (
    <div
      ref={element}
      className="pointer-events-none absolute right-2 top-2 z-10 max-w-[min(90%,32rem)]"
    >
      {status.phase !== "standby" ? (
        <div
          className={`rounded bg-background/95 px-2 py-1 text-xs ${status.phase === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          <span role="status" aria-live="polite">
            {status.message}
          </span>
          {status.phase === "request" ? (
            <button
              type="button"
              className="pointer-events-auto ml-2 rounded border px-2 py-1 text-foreground focus-visible:outline-2"
              onClick={() => audio?.approveMicrophone(status.requestId)}
            >
              Enable microphone
            </button>
          ) : status.phase !== "error" ? (
            <button
              type="button"
              className="pointer-events-auto ml-2 rounded border px-2 py-1 text-foreground focus-visible:outline-2"
              onClick={() => audio?.stopMicrophone()}
            >
              Stop microphone
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
