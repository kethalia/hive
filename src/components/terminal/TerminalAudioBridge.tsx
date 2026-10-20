"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { AudioDeviceControl } from "@/components/terminal/TerminalAudioControls";
import { terminalAuthProtocols } from "@/lib/terminal/auth-transport";
import {
  TerminalAudio,
  type TerminalAudioDevices,
  type TerminalAudioStatus,
} from "@/lib/terminal/browser-audio";
import {
  TERMINAL_AUDIO_PRIME_EVENT,
  TERMINAL_NOTIFICATION_FOCUS_EVENT,
} from "@/lib/terminal/events";

export function TerminalAudioBridge({
  proxyUrl,
  workspaceId,
  agentId,
  sessionName,
  label = sessionName,
  onStartVoice,
  onNavigate,
  onFocusTerminal,
}: {
  proxyUrl: string;
  workspaceId: string;
  agentId: string;
  sessionName: string;
  label?: string;
  onStartVoice?: () => void;
  onNavigate?: (url: string) => void;
  onFocusTerminal?: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const controller = useRef<TerminalAudio | null>(null);
  const [header, setHeader] = useState<Element | null>(null);
  const [status, setStatus] = useState<TerminalAudioStatus>({ phase: "standby" });
  const [devices, setDevices] = useState<TerminalAudioDevices>({
    microphone: "disconnected",
    speaker: "disconnected",
    playing: false,
    focused: false,
    microphoneMuted: false,
    speakerMuted: false,
    listeningHere: false,
  });
  const callbacks = useRef({ onStartVoice, onNavigate, label });
  callbacks.current = { onStartVoice, onNavigate, label };
  useEffect(() => {
    setStatus({ phase: "standby" });
    if (!proxyUrl || !element.current) return;
    const terminal = element.current.closest<HTMLElement>('[data-terminal-surface="true"]');
    if (!terminal) return;
    let notification: string | number | undefined;
    let lastToast = -Infinity;
    const dismissToast = () => {
      if (notification === undefined) return;
      toast.dismiss(notification);
      notification = undefined;
    };
    const params = new URLSearchParams({ workspaceId, agentId, sessionName });
    const audio = new TerminalAudio(
      `${proxyUrl}/ws/audio?${params}`,
      setStatus,
      () => {
        if (!document.hasFocus()) return false;
        if (terminal.closest("[data-pane-mode]")?.getAttribute("data-active") === "false")
          return false;
        const focusedTerminal = document.activeElement?.closest('[data-terminal-surface="true"]');
        return !focusedTerminal || focusedTerminal === terminal;
      },
      (url) => terminalAuthProtocols(url, "hive-audio-v1"),
      (next) => {
        setDevices((previous) =>
          Object.keys(next).every(
            (key) =>
              previous[key as keyof TerminalAudioDevices] ===
              next[key as keyof TerminalAudioDevices],
          )
            ? previous
            : next,
        );
        // Returning to a pane consumes its notice; leaving it can notify again immediately.
        if (next.focused) lastToast = -Infinity;
        if (
          next.focused ||
          next.listeningHere ||
          next.speaker === "disconnected" ||
          next.speakerMuted
        )
          dismissToast();
        else if (next.playing && Date.now() - lastToast > 15_000) {
          lastToast = Date.now();
          dismissToast();
          notification = toast(`${callbacks.current.label} is streaming sound`, {
            position: "bottom-right",
            description: "Go to the pane or listen to this reply here.",
            duration: 10_000,
            style: { display: "grid", gridTemplateColumns: "1fr auto" },
            classNames: { content: "col-span-2 min-w-0" },
            cancelButtonStyle: { marginLeft: "auto" },
            actionButtonStyle: { marginLeft: 0 },
            cancel: {
              label: "Listen here",
              onClick: () => {
                if (!audio.listenToCurrentReply())
                  toast("This reply is no longer available.", { position: "bottom-right" });
              },
            },
            action: {
              label: "Go to pane",
              onClick: () => {
                // Let the toaster restore its previous focus before selecting the target.
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                const event = new CustomEvent(TERMINAL_NOTIFICATION_FOCUS_EVENT, {
                  cancelable: true,
                  detail: { workspaceId, sessionName },
                });
                if (window.dispatchEvent(event))
                  callbacks.current.onNavigate?.(
                    `/workspaces/${encodeURIComponent(workspaceId)}/terminal/workspace?session=${encodeURIComponent(sessionName)}`,
                  );
              },
            },
          });
        }
      },
    );
    controller.current = audio;
    let inView = false;
    const update = () => {
      const frame = terminal.closest('[data-terminal-audio-frame="true"]');
      const shell = terminal.closest('[data-terminal-audio-shell="true"]');
      setHeader(
        frame?.querySelector('[data-terminal-audio-slot="true"]') ??
          shell?.querySelector('[data-terminal-audio-slot="true"]') ??
          null,
      );
      audio.setPageActive(document.visibilityState === "visible" && document.hasFocus());
      audio.setVisible(inView && !terminal.closest("[inert]"));
      audio.refreshFocus();
    };
    const focus = () => queueMicrotask(update);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    observer.observe(terminal);
    // Persistent terminal surfaces move between headers and parking without remounting.
    const parking = new MutationObserver(update);
    parking.observe(document.body, {
      subtree: true,
      childList: true,
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
    update();
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
      dismissToast();
      if (controller.current === audio) controller.current = null;
    };
  }, [proxyUrl, workspaceId, agentId, sessionName]);

  const audio = controller.current;
  const connect = (device: "microphone" | "speaker") => {
    onFocusTerminal?.();
    // Pane activation commits after the click; keep the action bound to this controller.
    queueMicrotask(() => {
      audio?.refreshFocus();
      if (status.phase === "request" && device === "microphone")
        audio?.approveMicrophone(status.requestId);
      else audio?.connectDevice(device, () => callbacks.current.onStartVoice?.());
    });
  };
  const controls = (
    <fieldset className="flex shrink-0 items-center gap-0.5" aria-label={`Audio for ${label}`}>
      <AudioDeviceControl
        device="microphone"
        muted={devices.microphoneMuted}
        phase={devices.microphone}
        message={
          status.phase === "error" || status.phase === "request" ? status.message : undefined
        }
        onConnect={() => connect("microphone")}
        onTogglePause={() => audio?.toggleMicrophone()}
        onStop={() => audio?.stopMicrophone()}
      />
      <AudioDeviceControl
        device="speaker"
        muted={devices.speakerMuted}
        message={
          status.phase === "error"
            ? status.message
            : devices.listeningHere
              ? "Playing this reply here. Later replies follow the focused pane."
              : undefined
        }
        phase={devices.speaker}
        playing={devices.playing}
        onConnect={() => connect("speaker")}
        onTogglePause={() => audio?.toggleSpeaker()}
        onStop={() => audio?.stopSpeaker()}
      />
    </fieldset>
  );
  return (
    <div ref={element}>
      {status.phase !== "standby" ? (
        <span className="sr-only" role="status">
          {status.message}
        </span>
      ) : null}
      {header ? createPortal(controls, header) : controls}
    </div>
  );
}
