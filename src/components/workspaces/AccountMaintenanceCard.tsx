"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  type accountMaintenanceRequestSchema,
  accountMaintenanceViewSchema,
} from "@/lib/codex-session/account-maintenance-contracts";

type View = z.infer<typeof accountMaintenanceViewSchema>;
type Input = z.infer<typeof accountMaintenanceRequestSchema>;
export function AccountMaintenanceCard({ workspaceId }: { workspaceId: string }) {
  const [stored, setStored] = useState<{ workspaceId: string; value: View } | null>(null),
    [pending, setPending] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState<string | null>(null);
  const epoch = useRef(0),
    mounted = useRef(false);
  const status = stored?.workspaceId === workspaceId ? stored.value : null;
  const send = useCallback(
    async (input: Input) => {
      const current = ++epoch.current;
      setPending(true);
      setError(null);
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/account-maintenance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify(input),
        });
        if (!mounted.current || current !== epoch.current) return;
        if (response.status === 404) {
          setStored(null);
          return;
        }
        if (!response.ok) throw Error();
        const value = accountMaintenanceViewSchema.parse(await response.json());
        if (mounted.current && current === epoch.current) {
          setStored({ workspaceId, value });
          setConfirmed(false);
        }
      } catch {
        if (mounted.current && current === epoch.current) setError(workspaceId);
      } finally {
        if (mounted.current && current === epoch.current) setPending(false);
      }
    },
    [workspaceId],
  );
  useEffect(() => {
    mounted.current = true;
    setConfirmed(false);
    void send({ action: "status" });
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [send]);
  useEffect(() => {
    if (
      pending ||
      (error !== workspaceId &&
        (!status ||
          !["requested", "waiting-boundary", "closing", "resuming"].includes(status.state)))
    )
      return;
    // A browser can lose the owner POST response after server persistence.
    // Poll only status until its durable state is known; never resend the owner
    // mutation or generate another request identity from an uncertain outcome.
    const timer = setInterval(() => void send({ action: "status" }), 5000);
    return () => clearInterval(timer);
  }, [status, pending, send, error, workspaceId]);
  if (!status && error !== workspaceId) return null;
  const canPause = Boolean(
    status?.runtimeId &&
      status.runtimeGeneration &&
      ["available", "finished"].includes(status.state),
  );
  return (
    <section aria-label="Account maintenance" className="space-y-3 rounded-md border p-3">
      <h3 className="font-medium">Account maintenance</h3>
      <p className="text-sm">
        Pause new work to change accounts. Active turns and children finish naturally before the
        managed runtime closes. Unfinished tasks, history, checkout changes, and writer reservations
        are retained.
      </p>
      {status && (
        <p role="status">
          {status.state === "ready"
            ? "The managed tree has exited. You can change accounts below, then resume."
            : status.state === "held"
              ? "Maintenance is held. No account or task outcome is inferred; inspect the current status before continuing."
              : status.state === "finished"
                ? "The runtime has resumed with fresh authorization. Any existing task or writer hold still applies."
                : status.state.replaceAll("-", " ")}
        </p>
      )}
      {status?.holdReason === "external-outcome-unknown" && (
        <p role="alert">
          The previous delivery attempt has an unresolved outcome. Its writer reservation is
          retained; it will not be repeated automatically.
        </p>
      )}
      {error === workspaceId && (
        <p role="alert">
          The outcome is unknown. Refresh status; do not repeat an uncertain action.
        </p>
      )}
      {(canPause || status?.state === "ready") && (
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={pending}
          />
          {canPause
            ? "Pause new admissions and close the runtime after it becomes idle."
            : "Account changes are complete. Resume the retained task history with fresh authorization."}
        </label>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void send({ action: "status" })}
        >
          Refresh maintenance status
        </Button>
        {canPause && status?.runtimeId && status.runtimeGeneration && (
          <Button
            size="sm"
            disabled={pending || !confirmed || error === workspaceId}
            onClick={() =>
              void send({
                action: "request",
                confirmed: true,
                requestId: crypto.randomUUID(),
                expectedVersion: status.version,
                runtimeId: status.runtimeId as string,
                runtimeGeneration: status.runtimeGeneration as number,
              })
            }
          >
            Pause for account changes
          </Button>
        )}
        {status?.state === "ready" && status.maintenanceId && (
          <Button
            size="sm"
            disabled={pending || !confirmed || error === workspaceId}
            onClick={() =>
              void send({
                action: "resume",
                confirmed: true,
                requestId: crypto.randomUUID(),
                expectedVersion: status.version,
                maintenanceId: status.maintenanceId as string,
              })
            }
          >
            Resume retained work
          </Button>
        )}
      </div>
    </section>
  );
}
