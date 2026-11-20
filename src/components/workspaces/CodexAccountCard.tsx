"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import {
  CheckingConnection,
  ConnectedAccount,
  ConnectionProblem,
  DisconnectedAccount,
  RefreshConnectionButton,
} from "./ConnectionStatus";
import { DeviceSignIn } from "./PendingSignIn";

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
  const checkingConnection = !status && !failure && !unavailable;
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
      {unavailable && !failure && (
        <ConnectionProblem provider="Codex">
          This connection is unavailable in this Hive deployment.
        </ConnectionProblem>
      )}
      {failure && (
        <ConnectionProblem provider="Codex">
          {accountStatusErrorMessage(failure)}
          {status && " Showing the last confirmed account status."}
        </ConnectionProblem>
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
      {status?.state === "unknown" && !failure && (
        <ConnectionProblem provider="Codex">Refresh status to try again.</ConnectionProblem>
      )}
      {status && !["signed-in", "pending", "busy", "unknown"].includes(status.state) && (
        <DisconnectedAccount provider="Codex">
          {status.state === "expired"
            ? "The sign-in window expired. Start again for a new code."
            : status.state === "failed"
              ? "Sign-in did not complete. You can try again."
              : status.state === "cancelled"
                ? "Sign-in was cancelled. You can connect when you’re ready."
                : "Use your ChatGPT sign-in in this workspace."}
        </DisconnectedAccount>
      )}
      {status?.state === "pending" &&
        (status.pending ? (
          <DeviceSignIn
            provider="OpenAI"
            challenge={{ code: status.pending.userCode, url: status.pending.verificationUrl }}
            expiresAt={status.pending.expiresAt}
            remaining={expiresIn ?? 0}
            cancelDisabled={blocked || expired}
            cancelling={pendingAction === "cancel"}
            onCancel={() => void mutate("cancel")}
            onExpired={refreshStatus}
            linkRef={continueLink}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Getting Codex sign-in ready…
          </p>
        ))}
      {(status?.state !== "pending" || expired || Boolean(failure) || !status.pending) && (
        <div className="flex flex-wrap gap-2">
          <RefreshConnectionButton
            disabled={busy || managementBusy}
            refreshing={busy && pendingAction === "status"}
            onClick={refreshStatus}
          />
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
