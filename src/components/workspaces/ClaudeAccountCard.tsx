"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type ClaudeAccountRequest,
  type ClaudeAccountStatus,
  claudeAccountStatusSchema,
} from "@/lib/agents/claude-account-contracts";

export function ClaudeAccountCard({ workspaceId }: { workspaceId: string }) {
  const [stored, setStored] = useState<{ workspaceId: string; value: ClaudeAccountStatus } | null>(
    null,
  );
  const [input, setInput] = useState({ workspaceId, code: "" });
  const [pending, setPending] = useState(false),
    [errorWorkspace, setErrorWorkspace] = useState<string | null>(null);
  const codeId = useId();
  const epoch = useRef(0),
    mounted = useRef(true);
  const status = stored?.workspaceId === workspaceId ? stored.value : null;
  const code = input.workspaceId === workspaceId ? input.code : "",
    error = errorWorkspace === workspaceId;
  const send = useCallback(
    async (request: ClaudeAccountRequest) => {
      const current = ++epoch.current;
      setPending(true);
      setErrorWorkspace(null);
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/claude-account`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!mounted.current || current !== epoch.current) return;
        if (response.status === 404) {
          setStored(null);
          return;
        }
        if (!response.ok) throw Error();
        const value = claudeAccountStatusSchema.parse(await response.json());
        if (mounted.current && current === epoch.current) setStored({ workspaceId, value });
      } catch {
        if (mounted.current && current === epoch.current) setErrorWorkspace(workspaceId);
      } finally {
        if (mounted.current && current === epoch.current) setPending(false);
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
  const submitCode = () => {
    if (!status?.pending || status.pending.codeSubmitted || !/^[!-~]{1,2048}$/.test(code)) return;
    setInput({ workspaceId, code: "" }); // Never retain or automatically resend a code after an uncertain ACK.
    void send({
      action: "code",
      lifetimeId: status.lifetimeId,
      generation: status.generation,
      code,
    });
  };
  return (
    <section className="space-y-3 rounded-md border p-3" aria-label="Workspace Claude account">
      <h3 className="font-medium">Accounts · workspace Claude</h3>
      <p className="text-sm text-muted-foreground">
        Uses saved credentials in this workspace’s configured, official Claude CLI. Shell-only
        credentials and other running CLI processes are not inspected. Signing out does not promise
        provider-wide revocation.
      </p>
      {status && (
        <p role="status">
          {status.state === "busy"
            ? "Another account operation is active. Refresh status before retrying."
            : status.state.replaceAll("-", " ")}
        </p>
      )}
      {status?.pending && (
        <div className="space-y-2">
          <p className="text-sm">
            Local attempt expires at {new Date(status.pending.expiresAt).toLocaleTimeString()}.
          </p>
          <a
            href={status.pending.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Open official Claude sign-in
          </a>
          {status.pending.codeSubmitted ? (
            <p>Code submitted. Waiting for the official CLI to finish.</p>
          ) : (
            <>
              <label htmlFor={codeId} className="block text-sm">
                One-time sign-in code
                <Input
                  id={codeId}
                  type="password"
                  value={code}
                  maxLength={2048}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending || error}
                  onChange={(event) => setInput({ workspaceId, code: event.target.value })}
                />
              </label>
              <Button
                size="sm"
                disabled={pending || error || !/^[!-~]{1,2048}$/.test(code)}
                onClick={submitCode}
              >
                Submit code once
              </Button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert">
          Claude account controls are unavailable or the outcome is unknown. Refresh status; a code
          will not be retried automatically.
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
                {status.state === "signed-in" ? "Reconnect" : "Connect Claude"}
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
