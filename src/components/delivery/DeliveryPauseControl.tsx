"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type DeliveryTaskDetail, deliveryPauseReceiptSchema } from "@/lib/delivery/read-contracts";

type PauseRequest = {
  schemaVersion: 1;
  eventId: string;
  expectedVersion: number;
  paused: boolean;
};

export function DeliveryPauseControl({
  task,
  userId,
}: {
  task: DeliveryTaskDetail;
  userId: string;
}) {
  const client = useQueryClient();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [retryRequest, setRetryRequest] = useState<PauseRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function changePause() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    const input = retryRequest ?? {
      schemaVersion: 1 as const,
      eventId: crypto.randomUUID(),
      expectedVersion: task.version,
      paused: !task.pauseRequested,
    };
    // A lost response may follow a committed write. Retry these exact bytes;
    // never synthesize another toggle from stale task data.
    setRetryRequest(input);
    try {
      const response = await fetch(`/api/delivery/tasks/${task.id}/pause`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          setRetryRequest(null);
          setNotice(
            response.status === 401
              ? "Sign in again to change scheduling."
              : response.status === 409
                ? "The task changed. Review its current state before trying again."
                : "Scheduling could not be changed. Refresh the task before trying again.",
          );
        } else {
          throw new Error("pause_unavailable");
        }
      } else {
        deliveryPauseReceiptSchema.parse(await response.json());
        setRetryRequest(null);
        setNotice("Request recorded. Refreshing the current scheduling state.");
      }
    } catch {
      setNotice("The request could not be confirmed. Retry to check the same request safely.");
    } finally {
      await Promise.allSettled([
        client.invalidateQueries({ queryKey: ["delivery-task", userId, task.id] }),
        client.invalidateQueries({ queryKey: ["delivery-tasks", userId] }),
      ]);
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void changePause()}>
        {pending
          ? "Updating scheduling…"
          : retryRequest
            ? "Retry scheduling request"
            : task.pauseRequested
              ? "Resume scheduling"
              : "Pause scheduling"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Pausing prevents new steps from starting. Active work may continue until it can stop safely.
      </p>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </div>
  );
}
