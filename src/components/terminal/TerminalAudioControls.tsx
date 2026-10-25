"use client";

import { Mic, MicOff, Volume2, VolumeOff, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ShortcutTooltip } from "@/components/ui/shortcut-tooltip";
import { LONG_PRESS_MS, NO_TOUCH_STYLE, TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";
import { PANE_CONTROL_SHORTCUTS } from "@/lib/keyboard-shortcuts";
import type { AudioDevicePhase } from "@/lib/terminal/browser-audio";
import { TERMINAL_CONTROL_BUTTON_CLASS_NAME } from "@/lib/terminal/pane-controls";
import { cn } from "@/lib/utils";

function DisconnectedMicrophoneIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="microphone-disconnected-icon"
    >
      <rect x="6" y="2" width="6" height="12" rx="3" />
      <path d="M3 10v2a6 6 0 0 0 12 0v-2M9 18v4M5 22h8" />
      <path d="m17 2 5 5m0-5-5 5" />
    </svg>
  );
}

export function AudioDeviceControl({
  device,
  phase,
  playing = false,
  message,
  muted = false,
  onConnect,
  onTogglePause,
  onStop,
}: {
  device: "microphone" | "speaker";
  phase: AudioDevicePhase;
  playing?: boolean;
  message?: string;
  muted?: boolean;
  onConnect: () => void;
  onTogglePause: () => void;
  onStop: () => void;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  const toggle = useRef(onTogglePause);
  toggle.current = onTogglePause;
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  // State changes during a hold must not act on a replacement connection.
  useEffect(() => {
    if (phase === "disconnected" || phase === "connecting") clearTimeout(timer.current);
  }, [phase]);
  const label = device === "microphone" ? "Microphone" : "Speakers";
  const connected = phase === "connected" || phase === "paused";
  const Icon =
    device === "microphone"
      ? phase === "disconnected"
        ? DisconnectedMicrophoneIcon
        : phase === "paused"
          ? MicOff
          : Mic
      : phase === "disconnected"
        ? VolumeX
        : phase === "paused"
          ? VolumeOff
          : Volume2;
  const description = `${phase[0].toUpperCase() + phase.slice(1)}${playing ? " · Streaming sound" : ""}`;
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (!held.current) setOpen(value);
      }}
    >
      <ShortcutTooltip
        label={`${label}: ${phase}${playing ? ", streaming sound" : ""}`}
        shortcuts={PANE_CONTROL_SHORTCUTS[device].keys}
        trigger={
          <PopoverTrigger
            aria-label={`${label}: ${phase}${playing ? ", streaming sound" : ""}`}
            className={cn(
              TERMINAL_CONTROL_BUTTON_CLASS_NAME,
              "relative flex touch-manipulation items-center justify-center rounded-sm hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-ring",
              phase === "disconnected"
                ? "text-red-400"
                : phase === "paused" || phase === "connecting"
                  ? "text-orange-400"
                  : "text-green-400",
            )}
            style={NO_TOUCH_STYLE}
            data-audio-device={device}
            data-terminal-control={device}
            data-state={phase}
            data-streaming={playing ? "true" : "false"}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              event.stopPropagation();
              cancel();
              held.current = false;
              origin.current = { x: event.clientX, y: event.clientY };
              if (!connected) return;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              timer.current = setTimeout(() => {
                held.current = true;
                setOpen(false);
                toggle.current();
              }, LONG_PRESS_MS);
            }}
            onPointerMove={(event) => {
              if (
                Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) >
                TAP_THRESHOLD_PX
              )
                cancel();
            }}
            onPointerUp={cancel}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
            onContextMenu={(event) => {
              event.preventDefault();
              cancel();
            }}
            onClickCapture={(event) => {
              if (held.current) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={() => {
              held.current = false;
            }}
          >
            <span
              className={cn(
                "flex",
                phase === "connected" &&
                  (device === "microphone" || playing) &&
                  "motion-safe:animate-pulse",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
            </span>
            {playing ? (
              <span
                className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-green-400 motion-safe:animate-pulse"
                aria-hidden="true"
              />
            ) : null}
          </PopoverTrigger>
        }
      />
      <PopoverContent align="end" className="w-64" onClick={(event) => event.stopPropagation()}>
        <PopoverTitle>{label}</PopoverTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
        {phase === "paused" && !muted ? (
          <p className="text-xs text-muted-foreground">Focus this pane to resume audio.</p>
        ) : null}
        {phase === "disconnected" ? (
          <p className="text-xs text-muted-foreground">
            Open Codex in this pane before connecting.
          </p>
        ) : null}
        {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
        {connected || phase === "connecting" ? (
          <div className="grid gap-2">
            <Button variant="outline" size="sm" disabled={!connected} onClick={onTogglePause}>
              {muted ? "Resume" : "Pause"} {device === "microphone" ? "microphone" : "speakers"}
            </Button>
            <Button variant="destructive" size="sm" onClick={onStop}>
              Stop {device === "microphone" ? "microphone" : "speakers"}
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={onConnect}>
            Connect {device === "microphone" ? "microphone" : "speakers"}
          </Button>
        )}
        <p className="text-[11px] text-muted-foreground">
          Hold the icon to pause or resume. Audio follows the focused pane.
        </p>
      </PopoverContent>
    </Popover>
  );
}
