"use client";

import { ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import {
  accountStatusErrorMessage,
  useWorkspaceAccountConnection,
} from "@/hooks/useWorkspaceAccountConnection";
import { claudeAccountStatusSchema } from "@/lib/agents/claude-account-contracts";
import { AccountChallengeExpiry } from "./AccountChallengeExpiry";

export function ClaudeAccountCard({
  workspaceId,
  buildId,
}: {
  workspaceId: string;
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
  const codeHintId = useId();
  const connectButton = useRef<HTMLButtonElement>(null);
  const continueLink = useRef<HTMLAnchorElement>(null);
  const nextFocus = useRef<{ scope: string; target: "connect" | "challenge" } | null>(null);
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
    if (action === "disconnect") {
      if (next.state === "signed-out") setFeedback({ scope, notice: "Claude disconnected." });
    }
    if (action === "cancel") {
      setFeedback({
        scope,
        notice:
          next.state === "signed-in"
            ? "Claude sign-in completed before cancellation."
            : next.state === "cancelled"
              ? "Claude sign-in cancelled."
              : next.state === "expired"
                ? "The Claude sign-in window expired."
                : next.state === "signed-out"
                  ? "Claude sign-in ended."
                  : "Cancellation has not been confirmed. Refresh status to check its progress.",
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

  return (
    <section
      className="space-y-4 rounded-md border p-4"
      aria-label="Workspace Claude account"
      aria-busy={busy}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Claude</h3>
        {status?.state === "signed-in" && <Badge>Connected</Badge>}
        {status?.state === "pending" && <Badge variant="secondary">Awaiting sign-in</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">
        Connect through the official Claude CLI configured in this workspace.
      </p>
      {!status && (busy || (!failure && !unavailable)) && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          Checking Claude connection…
        </p>
      )}
      {unavailable && !failure && (
        <p role="status" className="text-sm text-muted-foreground">
          Claude connection is unavailable. Check workspace bridge setup and refresh.
        </p>
      )}
      {pendingAction && status && (
        <p role="status" className="text-sm text-muted-foreground">
          Updating Claude connection…
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
        <p role="status" className="text-sm">
          {status.account?.email || status.account?.plan
            ? `${status.account.email ?? "Workspace Claude account"}${status.account.plan ? ` · ${status.account.plan}` : ""}`
            : "The workspace’s Claude account is connected."}
        </p>
      )}
      {status?.state === "busy" && (
        <p role="status" className="text-sm">
          Another account operation is active. Refresh status to continue.
        </p>
      )}
      {status?.state === "unknown" && (
        <p role="status" className="text-sm">
          Claude account status could not be confirmed. Refresh status to continue.
        </p>
      )}
      {status && !["signed-in", "pending", "busy", "unknown"].includes(status.state) && (
        <div className="space-y-1 rounded-md border border-dashed p-4 text-sm" role="status">
          <p className="font-medium">No Claude account connected</p>
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
                Open official Claude sign-in
                <ExternalLink aria-hidden="true" className="size-4" />
              </a>
              {status.pending.codeSubmitted ? (
                <p role="status" className="text-sm">
                  Code submitted. Waiting for the official CLI to finish.
                </p>
              ) : (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitCode();
                  }}
                >
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
                    aria-describedby={codeHintId}
                    disabled={blocked || codeLocked}
                    onChange={(event) => setInput({ attempt, code: event.target.value })}
                  />
                  <p id={codeHintId} className="text-xs text-muted-foreground">
                    Paste the one-time code from Claude after completing sign-in.
                  </p>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={blocked || codeLocked || !/^[!-~]{1,2048}$/.test(code)}
                  >
                    Submit code once
                  </Button>
                  {codeLocked && (
                    <p role="status" className="text-sm">
                      Code submission is awaiting confirmation. Refresh status to check its
                      progress.
                    </p>
                  )}
                </form>
              )}
            </>
          ) : (
            <p role="status" className="text-sm">
              Getting Claude sign-in ready…
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setFeedback(null);
            void refresh();
          }}
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
                  : "Connect Claude"}
            </Button>
          ))}
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
              <DialogTitle>Disconnect Claude?</DialogTitle>
              <DialogDescription>
                This signs the workspace’s Claude account out. Active Claude work may be
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
                {pendingAction === "disconnect" ? "Disconnecting…" : "Disconnect Claude"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </section>
  );
}
