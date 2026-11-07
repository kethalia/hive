"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type CodexAccountRequest,
  type CodexAccountStatus,
  codexAccountStatusSchema,
} from "@/lib/agents/codex-account-contracts";

export function CodexAccountCard({ workspaceId }: { workspaceId: string }) {
  const [storedStatus, storeStatus] = useState<{
    workspaceId: string;
    value: CodexAccountStatus;
  } | null>(null);
  const status = storedStatus?.workspaceId === workspaceId ? storedStatus.value : null;
  const [pending, setPending] = useState(false),
    [errorWorkspace, setErrorWorkspace] = useState<string | null>(null);
  const error = errorWorkspace === workspaceId;
  const epoch = useRef(0),
    mounted = useRef(true);
  const send = useCallback(
    async (input: CodexAccountRequest) => {
      const requestEpoch = ++epoch.current;
      setPending(true);
      setErrorWorkspace(null);
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/codex-account`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!mounted.current || epoch.current !== requestEpoch) return;
        if (response.status === 404) {
          storeStatus(null);
          return;
        }
        if (!response.ok) throw Error();
        const parsed = codexAccountStatusSchema.parse(await response.json());
        if (mounted.current && epoch.current === requestEpoch)
          storeStatus({ workspaceId, value: parsed });
      } catch {
        if (mounted.current && epoch.current === requestEpoch) setErrorWorkspace(workspaceId);
      } finally {
        if (mounted.current && epoch.current === requestEpoch) setPending(false);
      }
    },
    [workspaceId],
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
  if (!status && !error) return null;
  const mutate = (action: "connect" | "reconnect" | "cancel" | "disconnect") => {
    if (status) void send({ action, lifetimeId: status.lifetimeId, generation: status.generation });
  };
  return (
    <section className="space-y-3 rounded-md border p-3" aria-label="Managed Codex account">
      <h3 className="font-medium">Accounts · managed Codex</h3>
      <p className="text-sm text-muted-foreground">
        This workspace’s managed runtime has separate credentials from your personal CLI.
      </p>
      {status && (
        <p role="status">
          {status.state === "busy"
            ? "A managed runtime is running. Account changes require it to close; finishing a turn is not enough. Retry after it closes. This will not stop it."
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
            Enter this one-time code: <strong>{status.pending.userCode}</strong>
          </p>
          <p className="text-sm">Waiting for authorization. This attempt expires automatically.</p>
        </div>
      )}
      {error && <p role="alert">Account outcome is unknown. Refresh status before trying again.</p>}
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
