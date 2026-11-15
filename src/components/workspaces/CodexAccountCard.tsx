"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type CodexAccountRequest,
  type CodexAccountStatus,
  codexAccountStatusSchema,
} from "@/lib/agents/codex-account-contracts";

export function CodexAccountCard({
  workspaceId,
  buildId,
}: {
  workspaceId: string;
  buildId: string;
}) {
  const scope = `${workspaceId}/${buildId}`;
  const [storedStatus, storeStatus] = useState<{
    scope: string;
    value: CodexAccountStatus | null;
  } | null>(null);
  const status = storedStatus?.scope === scope ? storedStatus.value : null;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ scope: string; mutation: boolean } | null>(null);
  const error = failure?.scope === scope;
  const epoch = useRef(0);
  const mounted = useRef(true);
  const send = useCallback(
    async (input: CodexAccountRequest) => {
      const requestEpoch = ++epoch.current;
      setPending(true);
      setFailure(null);
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/codex-account`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ buildId, request: input }),
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!mounted.current || epoch.current !== requestEpoch) return;
        if (response.status === 404) {
          storeStatus({ scope, value: null });
          return;
        }
        if (!response.ok) throw Error();
        const parsed = codexAccountStatusSchema.parse(await response.json());
        if (mounted.current && epoch.current === requestEpoch)
          storeStatus({ scope, value: parsed });
      } catch {
        if (mounted.current && epoch.current === requestEpoch)
          setFailure({ scope, mutation: input.action !== "status" });
      } finally {
        if (mounted.current && epoch.current === requestEpoch) setPending(false);
      }
    },
    [workspaceId, buildId, scope],
  );
  useEffect(() => {
    mounted.current = true;
    void send({ action: "status" });
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [send]);
  useEffect(() => {
    if (status?.state !== "pending" || pending) return;
    const timer = setInterval(() => {
      void send({ action: "status" });
    }, 3000);
    return () => clearInterval(timer);
  }, [status?.state, pending, send]);
  const unavailable = storedStatus?.scope === scope && storedStatus.value === null;
  const mutate = (action: "connect" | "reconnect" | "cancel" | "disconnect") => {
    if (status) void send({ action, lifetimeId: status.lifetimeId, generation: status.generation });
  };
  return (
    <section className="space-y-3 rounded-md border p-3" aria-label="Managed Codex account">
      <h3 className="font-medium">Codex</h3>
      <p className="text-sm text-muted-foreground">
        Connect the workspace’s managed Codex account with your ChatGPT sign-in.
      </p>
      {!status && !error && (!unavailable || pending) && (
        <p role="status">Checking Codex connection…</p>
      )}
      {unavailable && !pending && !error && (
        <p role="status">
          Codex connection is unavailable. Check workspace bridge setup and refresh.
        </p>
      )}
      {pending && status && <p role="status">Updating Codex connection…</p>}
      {status && (
        <p role="status">
          {status.state === "busy"
            ? "Codex is using these credentials. Refresh status after it closes."
            : status.state.replaceAll("-", " ")}
        </p>
      )}
      {status?.pending && (
        <div className="space-y-2">
          <a
            href={status.pending.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Open official Codex sign-in
          </a>
          <p>
            Enter this one-time code <strong>{status.pending.userCode}</strong>
          </p>
          <p className="text-sm">
            Local attempt expires at {new Date(status.pending.expiresAt).toLocaleTimeString()}.
          </p>
        </div>
      )}
      {error && (
        <p role="alert">
          {failure?.mutation
            ? "Account outcome is unknown. Refresh status before trying again."
            : "Account status unavailable. Check workspace bridge setup and refresh."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void send({ action: "status" })}
        >
          Refresh status
        </Button>
        {status &&
          status.state !== "busy" &&
          !error &&
          (status.state === "pending" ? (
            <Button size="sm" disabled={pending} onClick={() => mutate("cancel")}>
              Cancel sign-in
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => mutate(status.state === "signed-in" ? "reconnect" : "connect")}
              >
                {status.state === "signed-in" ? "Reconnect" : "Connect Codex"}
              </Button>
              {status.state === "signed-in" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => mutate("disconnect")}
                >
                  Disconnect
                </Button>
              )}
            </>
          ))}
      </div>
    </section>
  );
}
