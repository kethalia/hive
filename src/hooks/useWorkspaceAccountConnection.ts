"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClaudeAccountRequest,
  ClaudeAccountStatus,
} from "@/lib/agents/claude-account-contracts";
import type { CodexAccountRequest, CodexAccountStatus } from "@/lib/agents/codex-account-contracts";

type AccountStatus = CodexAccountStatus | ClaudeAccountStatus;
type AccountRequest = CodexAccountRequest | ClaudeAccountRequest;
interface Snapshot<Status> {
  scope: string;
  status: Status | null;
  checked: boolean;
  failure: { mutation: boolean } | null;
}

export const ACCOUNT_REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;

/** Each account/build owns one bounded request. Recovery always reads status. */
export function useWorkspaceAccountConnection<Status extends AccountStatus>({
  workspaceId,
  buildId,
  provider,
  schema,
  suspended = false,
}: {
  workspaceId: string;
  buildId: string;
  provider: "codex" | "claude";
  schema: { parse: (value: unknown) => Status };
  suspended?: boolean;
}) {
  const scope = JSON.stringify([workspaceId, buildId, provider]);
  const [snapshot, setSnapshot] = useState<Snapshot<Status> | null>(null);
  const [activity, setActivity] = useState<{
    scope: string;
    action: AccountRequest["action"];
    background: boolean;
  } | null>(null);
  const active = useRef<{
    scope: string;
    controller: AbortController;
    action: AccountRequest["action"];
    background: boolean;
  } | null>(null);
  const visible = snapshot?.scope === scope ? snapshot : null;
  const status = visible?.status ?? null;
  const pendingAction = activity?.scope === scope ? activity.action : null;

  const send = useCallback(
    async (
      request: AccountRequest,
      { background = false }: { background?: boolean } = {},
    ): Promise<Status | null | undefined> => {
      const previous = active.current;
      if (previous) {
        if (
          previous.action !== "status" ||
          (request.action === "status" && (background || !previous.background))
        )
          return;
        active.current = null;
        previous.controller.abort();
      }
      const flight = {
        scope,
        controller: new AbortController(),
        action: request.action,
        background,
      };
      active.current = flight;
      setActivity({ scope, action: request.action, background });
      let rejectAbort: () => void = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error("Account request interrupted"));
        flight.controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const timer = setTimeout(() => flight.controller.abort(), ACCOUNT_REQUEST_TIMEOUT_MS);
      try {
        const read = fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/${provider}-account`,
          {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ buildId, request }),
            signal: flight.controller.signal,
          },
        ).then(async (response) => {
          if (response.status === 404 && request.action === "status") return null;
          if (!response.ok) throw new Error("Account response unavailable");
          return schema.parse(await response.json());
        });
        const value = await Promise.race([read, interrupted]);
        if (active.current !== flight || flight.controller.signal.aborted) return;
        setSnapshot({
          scope,
          status: value,
          checked: true,
          failure:
            request.action === "disconnect" && value?.state !== "signed-out"
              ? { mutation: true }
              : null,
        });
        return value;
      } catch {
        if (active.current === flight) {
          setSnapshot((current) => ({
            scope,
            status: current?.scope === scope ? current.status : null,
            checked: current?.scope === scope ? current.checked : false,
            failure: {
              mutation:
                request.action !== "status" ||
                (current?.scope === scope && current.failure?.mutation === true),
            },
          }));
        }
      } finally {
        clearTimeout(timer);
        flight.controller.signal.removeEventListener("abort", rejectAbort);
        if (active.current === flight) {
          active.current = null;
          setActivity(null);
        }
      }
    },
    [workspaceId, buildId, provider, schema, scope],
  );
  const refresh = useCallback(() => send({ action: "status" }), [send]);
  const recheck = useCallback(() => send({ action: "status" }, { background: true }), [send]);

  useEffect(() => {
    void refresh();
    return () => {
      const flight = active.current;
      if (flight?.scope === scope) {
        active.current = null;
        flight.controller.abort();
      }
    };
  }, [refresh, scope]);

  useEffect(() => {
    if (suspended) return;
    const check = () => {
      if (document.visibilityState === "visible") void recheck();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [recheck, suspended]);

  useEffect(() => {
    if (status?.state !== "pending" || pendingAction || visible?.failure || suspended) return;
    const timer = setTimeout(() => void recheck(), POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [status, pendingAction, visible?.failure, suspended, recheck]);

  const deadline = status?.state === "pending" ? status.pending?.expiresAt : undefined;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!deadline) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      if (deadline > current) timer = setTimeout(tick, Math.min(1000, deadline - current));
    };
    tick();
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [deadline]);
  const expiresIn = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
  const expired = expiresIn === 0;
  useEffect(() => {
    if (deadline && expired && !suspended) void recheck();
  }, [expired, deadline, suspended, recheck]);

  return {
    scope,
    status,
    pendingAction,
    busy: pendingAction !== null && activity?.background === false,
    unavailable: visible?.checked === true && !status,
    failure: visible?.failure ?? null,
    expiresIn,
    expired,
    refresh,
    send,
  };
}
