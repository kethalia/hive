"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

type ConnectionStatus = "connecting" | "streaming" | "waiting" | "ended" | "error";

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

export function AgentStreamPanel({
  taskId,
  status,
}: {
  taskId: string;
  status: string;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  useEffect(() => {
    if (status !== "running") {
      return;
    }

    setConnectionStatus("connecting");
    setLines([]);

    const es = new EventSource(`/api/tasks/${taskId}/stream`);

    es.onmessage = (event) => {
      setConnectionStatus("streaming");
      setLines((prev) => [...prev, event.data]);
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
  }, [taskId, status]);

  // Don't render anything for non-running tasks
  if (status !== "running") {
    return null;
  }

  return (
    <Card data-testid="agent-stream-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          <span
            data-testid="status-dot"
            className={`inline-block h-2 w-2 rounded-full ${statusDotColor[connectionStatus]}`}
          />
          Live Agent Activity
          <span
            data-testid="status-label"
            className="ml-auto text-xs font-normal normal-case tracking-normal"
          >
            {statusLabel[connectionStatus]}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px]">
          {lines.length === 0 &&
          (connectionStatus === "connecting" ||
            connectionStatus === "waiting") ? (
            <p
              data-testid="waiting-message"
              className="text-sm text-muted-foreground"
            >
              Waiting for agent output…
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
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
