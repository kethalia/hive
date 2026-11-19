"use client";

import { ExternalLink, LoaderCircle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
import {
  accountStatusErrorMessage,
  useWorkspaceAccountConnection,
} from "@/hooks/useWorkspaceAccountConnection";
import {
  type CodexAccountStatus,
  codexAccountStatusSchema,
} from "@/lib/agents/codex-account-contracts";
import { AccountChallengeExpiry } from "./AccountChallengeExpiry";
import {
  CheckingConnection,
  ConnectedAccount,
  DeviceCode,
  DisconnectedAccount,
} from "./ConnectionStatus";

export function CodexAccountCard({
  workspaceId,
  workspaceName = workspaceId,
  buildId,
  managementBusy = false,
  showConnection = true,
  children,
}: {
  workspaceId: string;
  workspaceName?: string;
  buildId: string;
  managementBusy?: boolean;
  showConnection?: boolean;
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
  } | null>(null);
  const [disconnect, setDisconnect] = useState<{
    scope: string;
    lifetimeId: string;
    generation: number;
  } | null>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const continueLink = useRef<HTMLAnchorElement>(null);
  const nextFocus = useRef<{ scope: string; target: "connect" | "challenge" } | null>(null);
  const checkingConnection = !status && (busy || (!failure && !unavailable));
  const blocked = busy || managementBusy || Boolean(failure);
  const disconnectStale = Boolean(
    disconnect &&
      (disconnect.scope !== scope ||
        disconnect.lifetimeId !== status?.lifetimeId ||
        disconnect.generation !== status?.generation ||
        status?.state !== "signed-in"),
  );
  const notice = feedback?.scope === scope ? feedback.notice : undefined;
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
    if (action === "disconnect" && next.state === "signed-out")
      toast.success("Codex disconnected.");
    if (action === "cancel") {
      if (next.state === "signed-in") toast.message("Codex sign-in completed before cancellation.");
      else if (next.state === "cancelled" || next.state === "signed-out")
        toast.message("Codex sign-in cancelled.");
      else if (next.state !== "expired")
        setFeedback({
          scope,
          notice: "Cancellation has not been confirmed. Refresh status to check its progress.",
        });
    }
  }

  if (checkingConnection) return <CheckingConnection provider="Codex" />;

  if (!showConnection)
    return status?.state === "signed-in" ? (
      children?.(status, { refresh: refreshStatus, busy })
    ) : (
      <p className="text-sm text-muted-foreground">Connect Codex in the Connection tab.</p>
    );

  return (
    <section className="space-y-4" aria-label="Managed Codex account" aria-busy={busy}>
      {status?.state !== "pending" && status?.state !== "signed-in" && (
        <p className="text-sm text-muted-foreground">
          Connect the workspace’s managed Codex account with your ChatGPT sign-in.
        </p>
      )}
      {unavailable && !failure && (
        <p role="status" className="text-sm text-muted-foreground">
          Codex connection is unavailable. Check workspace bridge setup and refresh.
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
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {status?.state === "signed-in" && (
        <ConnectedAccount
          provider="Codex"
          workspace={workspaceName}
          account={status.account?.email}
          plan={status.account?.plan}
        />
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
        <DisconnectedAccount provider="Codex">
          {status.state === "expired"
            ? "The sign-in window expired. Start again for a new code."
            : status.state === "failed"
              ? "Sign-in did not complete. You can try again."
              : status.state === "cancelled"
                ? "Sign-in was cancelled. You can connect when you’re ready."
                : "Your connection will appear here after sign-in."}
        </DisconnectedAccount>
      )}
      {status?.state === "pending" && (
        <div className="mx-auto max-w-md space-y-4 text-center">
          {expired ? (
            <>
              {status.pending && (
                <AccountChallengeExpiry expiresAt={status.pending.expiresAt} remaining={0} />
              )}
              <p role="status" className="text-sm">
                The sign-in window expired. Refresh status to continue.
              </p>
            </>
          ) : status.pending ? (
            <>
              <p className="text-sm text-muted-foreground">Enter this code on OpenAI.</p>
              <DeviceCode
                code={status.pending.userCode}
                expiresAt={status.pending.expiresAt}
                disabled={blocked}
                onExpired={refreshStatus}
              />
              {expiresIn !== null && (
                <div className="flex items-center gap-2 before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                  <AccountChallengeExpiry
                    expiresAt={status.pending.expiresAt}
                    remaining={expiresIn}
                  />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
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
                  className={buttonVariants({
                    size: "sm",
                    className: "h-auto min-h-10 flex-1 whitespace-normal py-2",
                  })}
                >
                  Open OpenAI
                  <ExternalLink aria-hidden="true" className="size-4" />
                </a>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={() => void mutate("cancel")}
                >
                  {pendingAction === "cancel" ? "Cancelling…" : "Cancel sign-in"}
                </Button>
              </div>
            </>
          ) : (
            <p role="status" className="text-sm">
              Getting Codex sign-in ready…
            </p>
          )}
        </div>
      )}
      {(status?.state !== "pending" || expired || Boolean(failure) || !status.pending) && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || managementBusy}
            onClick={refreshStatus}
          >
            {status && busy && pendingAction === "status" && (
              <LoaderCircle
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            Refresh status
          </Button>
          {status?.state === "pending" && expired && (
            <Button size="sm" variant="outline" disabled>
              Cancel sign-in
            </Button>
          )}
          {status &&
            status.state !== "busy" &&
            status.state !== "unknown" &&
            !failure &&
            status.state !== "pending" && (
              <Button
                ref={connectButton}
                variant={status.state === "signed-in" ? "outline" : "default"}
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
            )}
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
              <DialogTrigger render={<Button size="sm" variant="destructive" disabled={blocked} />}>
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
                  This signs Codex out of {workspaceName}. Active Codex work may be interrupted. You
                  can reconnect when you’re ready.
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
      )}
      {status?.state === "signed-in" && children?.(status, { refresh: refreshStatus, busy })}
    </section>
  );
}
