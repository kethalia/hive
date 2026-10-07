"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrowserVoice, type VoiceState } from "@/lib/codex/browser-voice";
import type { VoiceThread } from "@/lib/codex/voice-session";

export function CodexVoiceControls({ workspaceId }: { workspaceId: string }) {
  const id = useId();
  const [threads, setThreads] = useState<VoiceThread[]>([]);
  const [threadId, setThreadId] = useState("");
  const [state, setState] = useState<VoiceState>("ended");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [muted, setMuted] = useState(false);
  const voice = useRef<BrowserVoice | null>(null);
  const listing = useRef<AbortController | null>(null);
  const active = state !== "ended";

  useEffect(() => {
    const stop = () => voice.current?.stop();
    const visibility = () => {
      if (document.visibilityState === "hidden") stop();
    };
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", visibility);
      voice.current?.stop();
      listing.current?.abort();
    };
  }, []);

  async function loadThreads() {
    listing.current?.abort();
    const abort = new AbortController();
    listing.current = abort;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/voice`, {
        signal: abort.signal,
      });
      if (!response.ok)
        throw new Error(
          "Could not list Codex sessions. Open a current Codex CLI session in this workspace first.",
        );
      const data = await response.json();
      if (abort.signal.aborted) return;
      setThreads(data.threads);
      setThreadId("");
      if (!data.threads.length)
        setError("No running Codex sessions found. Open Codex in the terminal, then refresh.");
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : "Could not list sessions.");
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }

  function start() {
    setError("");
    setMuted(false);
    const session = new BrowserVoice(setState, setError);
    voice.current = session;
    void session.start(workspaceId, threadId);
  }

  return (
    <details
      className="shrink-0 border-b border-border px-2 py-1 text-xs"
      onToggle={(event) => {
        if (event.currentTarget.open && !threads.length && !loading) void loadThreads();
      }}
    >
      <summary className="cursor-pointer py-1">
        Codex Voice (experimental)
        {active
          ? ` · ${state === "connecting" ? "Connecting" : muted ? "Muted" : "Microphone on"}`
          : ""}
      </summary>
      <div className="flex flex-wrap items-center gap-2 py-2">
        <label htmlFor={id}>Codex session</label>
        <select
          id={id}
          className="min-w-0 max-w-full flex-1 rounded border bg-background p-2"
          value={threadId}
          disabled={active || loading}
          onChange={(event) => setThreadId(event.target.value)}
        >
          <option value="">Choose the session open in this terminal</option>
          {threads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.name} · {thread.cwd} · {thread.id.slice(-8)}
            </option>
          ))}
        </select>
        {!active ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void loadThreads()}
            >
              {loading ? "Loading…" : "Refresh sessions"}
            </Button>
            <Button size="sm" disabled={!threadId || loading} onClick={start}>
              Start voice
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={state !== "connected"}
              aria-pressed={muted}
              onClick={() => {
                voice.current?.mute(!muted);
                setMuted(!muted);
              }}
            >
              {muted ? "Unmute" : "Mute"}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => voice.current?.stop()}>
              End voice
            </Button>
          </>
        )}
      </div>
      <p className="pb-2 text-muted-foreground">
        Use Start voice here for browser audio. Keep the terminal open for approvals. Voice ends
        when you leave this browser tab.
      </p>
      {error ? (
        <p role="alert" className="pb-2 text-destructive">
          {error}
        </p>
      ) : null}
      <span role="status" className="sr-only">
        {active
          ? `Voice ${state}. ${muted ? "Microphone muted." : "Microphone on."}`
          : "Voice ended."}
      </span>
    </details>
  );
}
