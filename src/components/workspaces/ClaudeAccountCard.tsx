"use client";

import { useEffect, useId, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import {
  accountStatusErrorMessage,
  useWorkspaceAccountConnection,
} from "@/hooks/useWorkspaceAccountConnection";
import { claudeAccountStatusSchema } from "@/lib/agents/claude-account-contracts";
import {
  CheckingConnection,
  ConnectedAccount,
  ConnectionProblem,
  DisconnectedAccount,
  RefreshConnectionButton,
} from "./ConnectionStatus";
import { PendingSignIn, SignInLink } from "./PendingSignIn";

export function ClaudeAccountCard({
  workspaceId,
  workspaceName = workspaceId,
  buildId,
}: {
  workspaceId: string;
  workspaceName?: string;
  buildId: string;
}) {
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
  } = useWorkspaceAccountConnection({
    workspaceId,
    buildId,
    provider: "claude",
    schema: claudeAccountStatusSchema,
  });
  const attempt =
    status?.state === "pending" && status.pending
      ? JSON.stringify([
          scope,
          status.lifetimeId,
          status.pending.verificationUrl,
          status.pending.expiresAt,
        ])
      : "";
  const [input, setInput] = useState({ attempt: "", code: "" });
  const code = input.attempt === attempt ? input.code : "";
  const [submittedAttempt, setSubmittedAttempt] = useState("");
  const codeLocked = Boolean(attempt && submittedAttempt === attempt);
  const [feedback, setFeedback] = useState<{ scope: string; notice: string } | null>(null);
  const [disconnect, setDisconnect] = useState<{
    scope: string;
    lifetimeId: string;
    generation: number;
  } | null>(null);
  const codeId = useId();
  const connectButton = useRef<HTMLButtonElement>(null);
  const continueLink = useRef<HTMLAnchorElement>(null);
  const nextFocus = useRef<{ scope: string; target: "connect" | "challenge" } | null>(null);
  const checkingConnection = !status && !failure && !unavailable;
  const blocked = busy || Boolean(failure);
  const notice = feedback?.scope === scope ? feedback.notice : undefined;
  const disconnectStale = Boolean(
    disconnect &&
      (disconnect.scope !== scope ||
        disconnect.lifetimeId !== status?.lifetimeId ||
        disconnect.generation !== status?.generation ||
        status?.state !== "signed-in"),
  );

  useEffect(() => {
    setInput((current) =>
      current.attempt === attempt && !expired
        ? current
        : { attempt: expired ? "" : attempt, code: "" },
    );
  }, [attempt, expired]);
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
      toast.success("Claude disconnected.");
    if (action === "cancel") {
      if (next.state === "signed-in")
        toast.message("Claude sign-in completed before cancellation.");
      else if (next.state === "cancelled" || next.state === "signed-out")
        toast.message("Claude sign-in cancelled.");
      else if (next.state !== "expired")
        setFeedback({
          scope,
          notice: "Cancellation has not been confirmed. Refresh status to check its progress.",
        });
    }
  }

  function submitCode() {
    if (status?.pending && status.pending.expiresAt <= Date.now()) {
      setInput({ attempt, code: "" });
      void refresh();
      return;
    }
    if (
      !status?.pending ||
      status.state !== "pending" ||
      status.pending.codeSubmitted ||
      expired ||
      blocked ||
      codeLocked ||
      !/^[!-~]{1,2048}$/.test(code)
    )
      return;
    setSubmittedAttempt(attempt);
    setInput({ attempt, code: "" });
    setFeedback(null);
    void send({
      action: "code",
      lifetimeId: status.lifetimeId,
      generation: status.generation,
      code,
    });
  }

  if (checkingConnection) return <CheckingConnection provider="Claude" />;

  return (
    <section className="space-y-4" aria-label="Workspace Claude account" aria-busy={busy}>
      {unavailable && !failure && (
        <ConnectionProblem provider="Claude">
          This connection is unavailable in this Hive deployment.
        </ConnectionProblem>
      )}
      {failure && (
        <ConnectionProblem provider="Claude">
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
          provider="Claude"
          workspace={workspaceName}
          account={status.account?.email}
          plan={status.account?.plan}
        />
      )}
      {status?.state === "busy" && (
        <p role="status" className="text-sm">
          Another account operation is active. Refresh status to continue.
        </p>
      )}
      {status?.state === "unknown" && !failure && (
        <ConnectionProblem provider="Claude">Refresh status to try again.</ConnectionProblem>
      )}
      {status && !["signed-in", "pending", "busy", "unknown"].includes(status.state) && (
        <DisconnectedAccount provider="Claude">
          {status.state === "expired"
            ? "The sign-in window expired. Start again for a new code."
            : status.state === "failed"
              ? "Sign-in did not complete. You can try again."
              : status.state === "cancelled"
                ? "Sign-in was cancelled. You can connect when you’re ready."
                : "Use your Claude sign-in in this workspace."}
        </DisconnectedAccount>
      )}
      {status?.state === "pending" &&
        (status.pending ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitCode();
            }}
          >
            <PendingSignIn
              instructions={
                expired || status.pending.codeSubmitted
                  ? undefined
                  : "Open Claude, then paste the code here."
              }
              expiresAt={status.pending.expiresAt}
              remaining={expiresIn ?? 0}
              primaryAction={
                !expired && !status.pending.codeSubmitted ? (
                  <Button
                    type="submit"
                    size="sm"
                    disabled={blocked || codeLocked || !/^[!-~]{1,2048}$/.test(code)}
                  >
                    Submit code
                  </Button>
                ) : undefined
              }
              cancelDisabled={blocked || expired}
              cancelling={pendingAction === "cancel"}
              onCancel={() => void mutate("cancel")}
            >
              {expired ? null : status.pending.codeSubmitted ? (
                <p role="status" className="text-sm">
                  Code submitted. Waiting for Claude.
                </p>
              ) : (
                <>
                  <div className="[&>a]:w-full">
                    <SignInLink
                      ref={continueLink}
                      provider="Claude"
                      href={status.pending.verificationUrl}
                      expiresAt={status.pending.expiresAt}
                      onExpired={() => void refresh()}
                    />
                  </div>
                  <div className="space-y-2 text-left">
                    <label htmlFor={codeId} className="block text-sm">
                      One-time sign-in code
                    </label>
                    <Input
                      id={codeId}
                      type="password"
                      value={code}
                      maxLength={2048}
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      disabled={blocked || codeLocked}
                      onChange={(event) => setInput({ attempt, code: event.target.value })}
                    />
                    {codeLocked && (
                      <p role="status" className="text-sm">
                        Code submission is awaiting confirmation. Refresh status to check its
                        progress.
                      </p>
                    )}
                  </div>
                </>
              )}
            </PendingSignIn>
          </form>
        ) : (
          <PendingSignIn
            cancelDisabled={blocked}
            cancelling={pendingAction === "cancel"}
            onCancel={() => void mutate("cancel")}
          >
            <p role="status" className="text-sm text-muted-foreground">
              Getting Claude sign-in ready…
            </p>
          </PendingSignIn>
        ))}
      {(status?.state !== "pending" ||
        expired ||
        failure ||
        codeLocked ||
        disconnect?.scope === scope ||
        !status.pending ||
        status.pending.codeSubmitted) && (
        <div className="flex flex-wrap gap-2">
          <RefreshConnectionButton
            disabled={busy}
            refreshing={busy && pendingAction === "status"}
            onClick={() => {
              setFeedback(null);
              void refresh();
            }}
          />
          {status &&
            status.state !== "busy" &&
            status.state !== "unknown" &&
            status.state !== "pending" &&
            !failure && (
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
                    : "Connect Claude"}
              </Button>
            )}
          <Dialog
            open={disconnect?.scope === scope}
            onOpenChange={(open) => {
              if (!busy)
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
                <DialogTitle>Disconnect Claude?</DialogTitle>
                <DialogDescription>
                  This signs Claude out of {workspaceName}. Active Claude work may be interrupted.
                  You can reconnect when you’re ready.
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
                  {pendingAction === "disconnect" ? "Disconnecting…" : "Disconnect Claude"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </section>
  );
}
