"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AccountChallengeExpiry } from "@/components/workspaces/AccountChallengeExpiry";
import {
  CheckingConnection,
  ConnectedAccount,
  DeviceCode,
  DisconnectedAccount,
} from "@/components/workspaces/ConnectionStatus";
import type { CoderWorkspace } from "@/lib/coder/types";
import { projectErrorCodeSchema, projectErrorMessages } from "@/lib/projects/contracts";
import { type GitHubStatus, githubStatusSchema } from "@/lib/projects/github-connection";

type Action = "status" | "start" | "cancel" | "disconnect" | "poll";
export function GitHubConnection({
  workspace,
  userId,
  visible,
}: {
  workspace: CoderWorkspace;
  userId: string;
  visible: boolean;
}) {
  const client = useQueryClient();
  const workspaceId = workspace.id;
  const buildId = workspace.latest_build.id;
  const key = ["github-connection", userId, workspaceId, buildId];
  const [busy, setBusy] = useState<Action | null>(null);
  const [failure, setFailure] = useState("");
  const [disconnect, setDisconnect] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function request(action: Action, revision?: string, signal?: AbortSignal) {
    const r = await fetch("/api/github/connection", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, buildId, action, revision }),
      signal,
    });
    const value = await r.json();
    if (!r.ok) {
      const code = projectErrorCodeSchema.safeParse(value.error);
      throw new Error(
        code.success
          ? projectErrorMessages[code.data]
          : "Could not check the workspace GitHub connection. Refresh to try again.",
      );
    }
    return githubStatusSchema.parse(value);
  }
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: key,
    queryFn: ({ signal, queryKey }) => {
      const previous = client.getQueryData<GitHubStatus>(queryKey);
      return previous?.pending
        ? request("poll", previous.revision, signal)
        : request("status", undefined, signal);
    },
    enabled: visible && !busy,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.data?.pending ? query.state.data.pending.interval * 1000 : false,
  });
  const pending = data?.pending;
  const expiresAt = pending?.expiresAt;
  useEffect(() => {
    if (!expiresAt || !visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, visible]);
  async function change(action: "start" | "cancel" | "disconnect", revision: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(action);
    setFailure("");
    try {
      await client.cancelQueries({ queryKey: key, exact: true });
      const next = await request(action, revision);
      client.setQueryData(key, next);
      if (mounted.current && action === "cancel" && !next.pending && !next.outcome)
        toast.message("GitHub sign-in ended.");
      if (mounted.current && action === "disconnect" && !next.login && !next.pending)
        toast.success("GitHub disconnected.");
    } catch (error) {
      if (mounted.current)
        setFailure(
          error instanceof Error
            ? error.message
            : "Could not confirm the operation. Refresh status.",
        );
    } finally {
      lock.current = false;
      if (mounted.current) {
        setBusy(null);
        setDisconnect(null);
      }
    }
  }
  const message = failure || error?.message;
  const refreshButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={isFetching || !!busy}
      onClick={() => {
        setFailure("");
        void refetch();
      }}
    >
      Refresh status
    </Button>
  );
  return (
    <section
      className="space-y-4"
      aria-label="Workspace GitHub connection"
      aria-busy={!!busy || isFetching}
    >
      {!data && !message && <CheckingConnection provider="GitHub" />}
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      {data &&
        (pending ? (
          <div className="mx-auto max-w-md space-y-4 text-center">
            {now < pending.expiresAt && (
              <>
                <p className="text-sm text-muted-foreground">Enter this code on GitHub.</p>
                <DeviceCode
                  code={pending.code}
                  expiresAt={pending.expiresAt}
                  onExpired={() => void refetch()}
                  disabled={!!busy}
                />
              </>
            )}
            <AccountChallengeExpiry
              expiresAt={pending.expiresAt}
              remaining={Math.max(0, Math.ceil((pending.expiresAt - now) / 1000))}
            />
            <div className="flex flex-wrap gap-2">
              {now < pending.expiresAt && (
                <a
                  className={buttonVariants({ size: "sm" })}
                  href="https://github.com/login/device"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Open GitHub <ExternalLink aria-hidden />
                </a>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => void change("cancel", data.revision)}
              >
                Cancel sign-in
              </Button>
            </div>
          </div>
        ) : (
          <>
            {data.login ? (
              <ConnectedAccount
                provider="GitHub"
                workspace={workspace.name}
                account={`@${data.login}`}
              />
            ) : (
              <DisconnectedAccount provider="GitHub">
                Connect GitHub to browse repositories in this workspace.
              </DisconnectedAccount>
            )}
            {data.outcome && (
              <p role="status">
                {data.outcome === "expired"
                  ? "The sign-in code expired. Start again for a new code."
                  : "GitHub sign-in did not complete. You can try again."}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {refreshButton}
              <Button
                size="sm"
                variant={data.login ? "outline" : "default"}
                disabled={!!busy || !!message}
                onClick={() => void change("start", data.revision)}
              >
                {busy === "start" ? "Starting…" : data.login ? "Reconnect" : "Connect GitHub"}
              </Button>
              {data.login && (
                <Dialog
                  open={disconnect !== null}
                  onOpenChange={(open) => {
                    if (!busy) setDisconnect(open ? data.revision : null);
                  }}
                >
                  <DialogTrigger
                    render={
                      <Button size="sm" variant="destructive" disabled={!!busy || !!message} />
                    }
                  >
                    Disconnect
                  </DialogTrigger>
                  <DialogContent showCloseButton={!busy}>
                    <DialogHeader>
                      <DialogTitle>Disconnect GitHub?</DialogTitle>
                      <DialogDescription>
                        This removes the GitHub connection from {workspace.name}.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => setDisconnect(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={!!busy || disconnect !== data.revision}
                        onClick={() => disconnect && void change("disconnect", disconnect)}
                      >
                        Disconnect GitHub
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          </>
        ))}
      {(!data || pending) && message && refreshButton}
    </section>
  );
}
