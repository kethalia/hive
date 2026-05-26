"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MAX_STREAM_LINES } from "@/lib/constants";

type ConnectionStatus = "connecting" | "streaming" | "waiting" | "ended" | "error";

const LIVE_TAIL_THRESHOLD_PX = 48;

const statusDotColor: Record<ConnectionStatus, string> = {
  connecting: "bg-yellow-400",
  waiting: "bg-yellow-400",
  streaming: "bg-green-500",
  ended: "bg-muted-foreground",
  error: "bg-destructive",
};

const statusLabel: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  waiting: "Waiting",
  streaming: "Streaming",
  ended: "Ended",
  error: "Error",
};

export function AgentStreamPanel({ taskId, status }: { taskId: string; status: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [isLiveTail, setIsLiveTail] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const liveTailRef = useRef(true);
  const shouldScrollAfterAppendRef = useRef(false);

  const setLiveTail = useCallback((next: boolean) => {
    if (liveTailRef.current === next) {
      return;
    }

    liveTailRef.current = next;
    setIsLiveTail(next);
  }, []);

  const isNearTail = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return true;
    }

    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <=
      LIVE_TAIL_THRESHOLD_PX
    );
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    setLiveTail(true);
  }, [setLiveTail]);

  const updateLiveTail = useCallback(() => {
    setLiveTail(isNearTail());
  }, [isNearTail, setLiveTail]);

  useEffect(() => {
    if (lines.length === 0 || !shouldScrollAfterAppendRef.current) {
      return;
    }

    shouldScrollAfterAppendRef.current = false;
    scrollToBottom();
  }, [lines, scrollToBottom]);

  useEffect(() => {
    if (status !== "running") {
      return;
    }

    setConnectionStatus("connecting");
    setLines([]);
    setLiveTail(true);
    shouldScrollAfterAppendRef.current = false;

    const es = new EventSource(`/api/tasks/${taskId}/stream`);

    es.onmessage = (event) => {
      const shouldFollowTail = isNearTail();
      setLiveTail(shouldFollowTail);
      shouldScrollAfterAppendRef.current = shouldFollowTail;
      setConnectionStatus("streaming");
      setLines((prev) => {
        const next = [...prev, event.data];
        return next.length > MAX_STREAM_LINES ? next.slice(-MAX_STREAM_LINES) : next;
      });
    };

    es.addEventListener("status", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        const s = payload.status as string;
        if (s === "connected") {
          setConnectionStatus("streaming");
        } else if (s === "waiting") {
          setConnectionStatus("waiting");
        } else if (s === "ended") {
          setConnectionStatus("ended");
          es.close();
        }
      } catch {
        // Ignore malformed status events
      }
    });

    es.onerror = () => {
      setConnectionStatus("error");
    };

    return () => {
      es.close();
    };
  }, [isNearTail, setLiveTail, status, taskId]);

  // Don't render anything for non-running tasks
  if (status !== "running") {
    return null;
  }

  return (
    <Card data-testid="agent-stream-panel">
      <CardHeader
        data-testid="agent-stream-header"
        className="sticky top-14 z-20 flex flex-row items-center justify-between gap-3 border-b bg-card/95 backdrop-blur md:static"
      >
        <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          <span
            data-testid="status-dot"
            className={`inline-block h-2 w-2 rounded-full ${statusDotColor[connectionStatus]}`}
          />
          Live Agent
          <span data-testid="status-label">{statusLabel[connectionStatus]}</span>
        </CardTitle>
        <Button
          type="button"
          variant="outline"
          size="icon"
          data-testid="scroll-to-bottom"
          data-at-tail={isLiveTail ? "true" : "false"}
          aria-label="Scroll to latest agent output"
          className="min-h-11 min-w-11 touch-manipulation md:min-h-8 md:min-w-8"
          onClick={scrollToBottom}
        >
          <span aria-hidden="true">↓</span>
        </Button>
      </CardHeader>
      <CardContent>
        <div
          ref={scrollContainerRef}
          data-testid="stream-scroll-container"
          className="h-[60svh] overflow-y-auto rounded-md bg-muted/30 p-3 pb-safe md:h-[400px]"
          onScroll={updateLiveTail}
        >
          {lines.length === 0 ? (
            <p data-testid="waiting-message" className="text-sm text-muted-foreground">
              Waiting for agent output
            </p>
          ) : (
            <pre
              data-testid="stream-output"
              className="whitespace-pre-wrap break-words font-mono text-sm text-foreground"
            >
              {lines.join("\n")}
            </pre>
          )}
          <div ref={bottomRef} />
        </div>
      </CardContent>
    </Card>
  );
}
