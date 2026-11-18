"use client";

import { Copy, ExternalLink, LoaderCircle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  accountStatusErrorMessage,
  useWorkspaceAccountConnection,
} from "@/hooks/useWorkspaceAccountConnection";
import {
  type CodexAccountStatus,
  codexAccountStatusSchema,
} from "@/lib/agents/codex-account-contracts";
import { AccountChallengeExpiry } from "./AccountChallengeExpiry";

export function CodexAccountCard({
  workspaceId,
  buildId,
  managementBusy = false,
  children,
}: {
  workspaceId: string;
  buildId: string;
  managementBusy?: boolean;
  children?: (
    status: CodexAccountStatus,
    controls: { refresh: () => void; busy: boolean },
  ) => ReactNode;
}) {
  const connection = useWorkspaceAccountConnection({
    workspaceId,
    buildId,
    provider: "codex",
    schema: codexAccountStatusSchema,
    suspended: managementBusy,
  });
  const {
    scope,
    status,
    busy,
    failure,
    unavailable,
    expired,
    expiresIn,
    pendingAction,
    send,
    refresh,
  } = connection;
  const [feedback, setFeedback] = useState<{
    scope: string;
    notice?: string;
    error?: string;
  } | null>(null);
  const [disconnect, setDisconnect] = useState<{
    scope: string;
    lifetimeId: string;
    generation: number;
  } | null>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const continueLink = useRef<HTMLAnchorElement>(null);
  const nextFocus = useRef<{ scope: string; target: "connect" | "challenge" } | null>(null);
  const blocked = busy || managementBusy || Boolean(failure);
  const disconnectStale = Boolean(
    disconnect &&
      (disconnect.scope !== scope ||
        disconnect.lifetimeId !== status?.lifetimeId ||
        disconnect.generation !== status?.generation ||
        status?.state !== "signed-in"),
  );
  const notice = feedback?.scope === scope ? feedback.notice : undefined;
  const copyError = feedback?.scope === scope ? feedback.error : undefined;
  const refreshStatus = useCallback(() => {
    setFeedback(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const intent = nextFocus.current;
    if (!intent || intent.scope !== scope) return;
    if (
      intent.target === "challenge" &&
      status?.state === "pending" &&
      !expired &&
      continueLink.current
    ) {
      continueLink.current.focus();
      nextFocus.current = null;
    }
    if (
      intent.target === "connect" &&
      status &&
      status.state !== "pending" &&
      connectButton.current
    ) {
      connectButton.current.focus();
      nextFocus.current = null;
    }
  }, [scope, status, expired]);

  async function mutate(action: "connect" | "reconnect" | "cancel" | "disconnect") {
    if (!status || blocked || status.state === "busy" || status.state === "unknown") return;
    if (
      action === "cancel" &&
      (expired || (status.pending && status.pending.expiresAt <= Date.now()))
    ) {
      void refresh();
      return;
    }
    const fence = action === "disconnect" ? disconnect : status;
    if (!fence || (action === "disconnect" && disconnectStale)) return;
    nextFocus.current = {
      scope,
      target: action === "connect" || action === "reconnect" ? "challenge" : "connect",
    };
    setFeedback(null);
    const next = await send({ action, lifetimeId: fence.lifetimeId, generation: fence.generation });
    if (action === "disconnect")
      setDisconnect((current) => (current?.scope === scope ? null : current));
    if (!next) return;
    if (action === "disconnect") {
      if (next.state === "signed-out") setFeedback({ scope, notice: "Codex disconnected." });
    }
    if (action === "cancel") {
      setFeedback({
        scope,
        notice:
          next.state === "signed-in"
            ? "Codex sign-in completed before cancellation."
            : next.state === "cancelled"
              ? "Codex sign-in cancelled."
              : next.state === "expired"
                ? "The Codex sign-in window expired."
                : next.state === "signed-out"
                  ? "Codex sign-in ended."
                  : "Cancellation has not been confirmed. Refresh status to check its progress.",
      });
    }
  }

  async function copyCode() {
    if (!status?.pending || blocked || expired) return;
    if (status.pending.expiresAt <= Date.now()) {
      void refresh();
      return;
    }
    setFeedback(null);
    try {
      await navigator.clipboard.writeText(status.pending.userCode);
      setFeedback({ scope, notice: "Sign-in code copied." });
    } catch {
      setFeedback({ scope, error: "Copy failed. Select and copy the code above." });
    }
  }

  return (
    <section
      className="space-y-4 rounded-md border p-4"
      aria-label="Managed Codex account"
      aria-busy={busy}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Codex</h3>
        {status?.state === "signed-in" && <Badge>Connected</Badge>}
        {status?.state === "pending" && <Badge variant="secondary">Awaiting sign-in</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">
        Connect the workspace’s managed Codex account with your ChatGPT sign-in.
      </p>
      {!status && (busy || (!failure && !unavailable)) && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          Checking Codex connection…
        </p>
      )}
      {unavailable && !failure && (
        <p role="status" className="text-sm text-muted-foreground">
          Codex connection is unavailable. Check workspace bridge setup and refresh.
        </p>
      )}
      {pendingAction && status && (
        <p role="status" className="text-sm text-muted-foreground">
          Updating Codex connection…
        </p>
      )}
      {failure && (
        <div className="space-y-1">
          <p role="alert" className="text-sm text-destructive">
            {accountStatusErrorMessage(failure)}
          </p>
          {status && (
            <p className="text-sm text-muted-foreground">
              Showing the last confirmed account status.
            </p>
          )}
        </div>
      )}
      {copyError && (
        <p role="alert" className="text-sm text-destructive">
          {copyError}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {status?.state === "signed-in" && (
        <p role="status" className="text-sm">
          {status.account?.email || status.account?.plan
            ? `${status.account.email ?? "Workspace Codex account"}${status.account.plan ? ` · ${status.account.plan}` : ""}`
            : "The workspace’s managed Codex account is connected."}
        </p>
      )}
      {status?.state === "busy" && (
        <p role="status" className="text-sm">
          Codex is using these credentials. Refresh status after it closes.
        </p>
      )}
      {status?.state === "unknown" && (
        <p role="status" className="text-sm">
          Codex account status could not be confirmed. Refresh status to continue.
        </p>
      )}
      {status && !["signed-in", "pending", "busy", "unknown"].includes(status.state) && (
        <div className="space-y-1 rounded-md border border-dashed p-4 text-sm" role="status">
          <p className="font-medium">No Codex account connected</p>
          <p className="text-muted-foreground">
            {status.state === "expired"
              ? "The sign-in window expired. Start again for a new code."
              : status.state === "failed"
                ? "Sign-in did not complete. You can try again."
                : status.state === "cancelled"
                  ? "Sign-in was cancelled. You can connect when you’re ready."
                  : "Your connection will appear here after sign-in."}
          </p>
        </div>
      )}
      {status?.state === "pending" && (
        <div className="space-y-3">
          {status.pending && expiresIn !== null && (
            <AccountChallengeExpiry expiresAt={status.pending.expiresAt} remaining={expiresIn} />
          )}
          {expired ? (
            <p role="status" className="text-sm">
              The sign-in window expired. Refresh status to continue.
            </p>
          ) : status.pending ? (
            <>
              <p className="text-sm">Enter this code on OpenAI to finish signing in.</p>
              <fieldset className="flex flex-wrap items-center gap-2">
                <legend className="sr-only">One-time Codex sign-in code</legend>
                <code className="select-all rounded-md border bg-muted px-3 py-2 font-mono text-lg font-semibold tracking-wider">
                  {status.pending.userCode}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={() => void copyCode()}
                >
                  <Copy aria-hidden="true" />
                  Copy code
                </Button>
              </fieldset>
              <a
                ref={continueLink}
                href={status.pending.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  if (status.pending && status.pending.expiresAt <= Date.now()) {
                    event.preventDefault();
                    void refresh();
                  }
                }}
                className="inline-flex items-center gap-2 text-sm underline underline-offset-4"
              >
                Open official Codex sign-in
                <ExternalLink aria-hidden="true" className="size-4" />
              </a>
            </>
          ) : (
            <p role="status" className="text-sm">
              Getting Codex sign-in ready…
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || managementBusy}
          onClick={refreshStatus}
        >
          Refresh status
        </Button>
        {status &&
          status.state !== "busy" &&
          status.state !== "unknown" &&
          !failure &&
          (status.state === "pending" ? (
            <Button size="sm" disabled={blocked || expired} onClick={() => void mutate("cancel")}>
              {pendingAction === "cancel" ? "Cancelling…" : "Cancel sign-in"}
            </Button>
          ) : (
            <Button
              ref={connectButton}
              size="sm"
              disabled={blocked}
              onClick={() => void mutate(status.state === "signed-in" ? "reconnect" : "connect")}
            >
              {pendingAction === "connect" || pendingAction === "reconnect"
                ? "Starting…"
                : status.state === "signed-in"
                  ? "Reconnect"
                  : "Connect Codex"}
            </Button>
          ))}
        <Dialog
          open={disconnect?.scope === scope}
          onOpenChange={(open) => {
            if (busy || (open && managementBusy)) return;
            setDisconnect(
              open && status?.state === "signed-in"
                ? { scope, lifetimeId: status.lifetimeId, generation: status.generation }
                : null,
            );
          }}
        >
          {status?.state === "signed-in" && (
            <DialogTrigger render={<Button size="sm" variant="outline" disabled={blocked} />}>
              Disconnect
            </DialogTrigger>
          )}
          <DialogContent
            showCloseButton={!busy}
            finalFocus={() =>
              status?.state === "signed-in" ? true : (connectButton.current ?? false)
            }
          >
            <DialogHeader>
              <DialogTitle>Disconnect Codex?</DialogTitle>
              <DialogDescription>
                This signs the workspace’s managed Codex account out. Active Codex work may be
                interrupted. You can reconnect when you’re ready.
              </DialogDescription>
            </DialogHeader>
            {disconnectStale && (
              <p role="alert" className="text-sm">
                The account connection changed. Close this dialog and refresh status before
                disconnecting.
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setDisconnect(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={blocked || disconnectStale}
                onClick={() => void mutate("disconnect")}
              >
                {pendingAction === "disconnect" ? "Disconnecting…" : "Disconnect Codex"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {status?.state === "signed-in" && children?.(status, { refresh: refreshStatus, busy })}
    </section>
  );
}
