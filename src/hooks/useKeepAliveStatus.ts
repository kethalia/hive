"use client";

import { useEffect, useRef, useState } from "react";
import { getClientRuntimeConfig } from "@/lib/runtime-config";

export type KeepAliveHealthStatus =
  | "healthy"
  | "failing"
  | "not-applicable"
  | "no-token"
  | "recently-disconnected";

export type KeepAliveFailureCategory =
  | "manual-shutdown"
  | "http-auth"
  | "http-client"
  | "http-server"
  | "timeout"
  | "network"
  | "unknown";

export type KeepAliveFailureReason =
  | "manual-shutdown"
  | "coder-auth-rejected"
  | "workspace-not-found"
  | "coder-client-error"
  | "coder-server-error"
  | "coder-timeout"
  | "network-error"
  | "unknown-error";

export interface KeepAliveStatus {
  status: KeepAliveHealthStatus;
  consecutiveFailures: number;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastFailureCategory: KeepAliveFailureCategory | null;
  lastFailureReason: KeepAliveFailureReason | null;
  lastFailureDetail: string | null;
  lastHttpStatus: number | null;
  lastHttpStatusText: string | null;
  lastAttemptDurationMs: number | null;
  activeConnectionCount: number;
  lastDisconnectedAt: string | null;
  isLoading: boolean;
}

const POLL_INTERVAL_MS = 30_000;
const KEEP_ALIVE_HEALTH_STATUSES = new Set<KeepAliveHealthStatus>([
  "healthy",
  "failing",
  "not-applicable",
  "no-token",
  "recently-disconnected",
]);
const KEEP_ALIVE_FAILURE_CATEGORIES = new Set<KeepAliveFailureCategory>([
  "manual-shutdown",
  "http-auth",
  "http-client",
  "http-server",
  "timeout",
  "network",
  "unknown",
]);
const KEEP_ALIVE_FAILURE_REASONS = new Set<KeepAliveFailureReason>([
  "manual-shutdown",
  "coder-auth-rejected",
  "workspace-not-found",
  "coder-client-error",
  "coder-server-error",
  "coder-timeout",
  "network-error",
  "unknown-error",
]);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const DEFAULT_KEEP_ALIVE_STATUS: KeepAliveStatus = {
  status: "healthy",
  consecutiveFailures: 0,
  lastAttempt: null,
  lastSuccess: null,
  lastFailure: null,
  lastFailureCategory: null,
  lastFailureReason: null,
  lastFailureDetail: null,
  lastHttpStatus: null,
  lastHttpStatusText: null,
  lastAttemptDurationMs: null,
  activeConnectionCount: 0,
  lastDisconnectedAt: null,
  isLoading: true,
};

export function terminalProxyHttpBaseUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, "http$1://");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseHealthStatus(value: unknown): KeepAliveHealthStatus {
  return typeof value === "string" && KEEP_ALIVE_HEALTH_STATUSES.has(value as KeepAliveHealthStatus)
    ? (value as KeepAliveHealthStatus)
    : "healthy";
}

function parseFailureCategory(value: unknown): KeepAliveFailureCategory | null {
  return typeof value === "string" &&
    KEEP_ALIVE_FAILURE_CATEGORIES.has(value as KeepAliveFailureCategory)
    ? (value as KeepAliveFailureCategory)
    : null;
}

function parseFailureReason(value: unknown): KeepAliveFailureReason | null {
  return typeof value === "string" &&
    KEEP_ALIVE_FAILURE_REASONS.has(value as KeepAliveFailureReason)
    ? (value as KeepAliveFailureReason)
    : null;
}

function parseCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parseNullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseHttpStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function parseNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 300 ? trimmed : null;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

export function parseWorkspaceStatus(payload: unknown, workspaceId: string): KeepAliveStatus {
  if (!isRecord(payload) || !isRecord(payload.workspaces)) {
    return { ...DEFAULT_KEEP_ALIVE_STATUS, isLoading: false };
  }

  const workspace = payload.workspaces[workspaceId];
  if (!isRecord(workspace)) {
    return { ...DEFAULT_KEEP_ALIVE_STATUS, isLoading: false };
  }

  return {
    status: parseHealthStatus(workspace.status),
    consecutiveFailures: parseCount(workspace.consecutiveFailures),
    lastAttempt: parseTimestamp(workspace.lastAttempt),
    lastSuccess: parseTimestamp(workspace.lastSuccess),
    lastFailure: parseTimestamp(workspace.lastFailure),
    lastFailureCategory: parseFailureCategory(workspace.lastFailureCategory),
    lastFailureReason: parseFailureReason(workspace.lastFailureReason),
    lastFailureDetail: parseNullableString(workspace.lastFailureDetail),
    lastHttpStatus: parseHttpStatus(workspace.lastHttpStatus),
    lastHttpStatusText: parseNullableString(workspace.lastHttpStatusText),
    lastAttemptDurationMs: parseNullableCount(workspace.lastAttemptDurationMs),
    activeConnectionCount: parseCount(workspace.activeConnectionCount),
    lastDisconnectedAt: parseTimestamp(workspace.lastDisconnectedAt),
    isLoading: false,
  };
}

export function parseKeepAliveStatusPayload(payload: unknown): Record<string, KeepAliveStatus> {
  if (!isRecord(payload) || !isRecord(payload.workspaces)) return {};

  const workspaces: Record<string, KeepAliveStatus> = {};
  for (const workspaceId of Object.keys(payload.workspaces)) {
    workspaces[workspaceId] = parseWorkspaceStatus(payload, workspaceId);
  }
  return workspaces;
}

export function useKeepAliveStatus(workspaceId: string): KeepAliveStatus {
  const [status, setStatus] = useState<KeepAliveStatus>(DEFAULT_KEEP_ALIVE_STATUS);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const proxyWsUrl = getClientRuntimeConfig().terminalWsUrl;
    if (!proxyWsUrl) {
      setStatus((s) => ({ ...s, isLoading: false }));
      return;
    }

    const baseUrl = terminalProxyHttpBaseUrl(proxyWsUrl);

    async function poll() {
      try {
        const res = await fetch(`${baseUrl}/keepalive/status`, {
          credentials: "include",
        });
        if (!res.ok) {
          if (mountedRef.current) setStatus((s) => ({ ...s, isLoading: false }));
          return;
        }
        const json: unknown = await res.json();

        if (!mountedRef.current) return;

        setStatus(parseWorkspaceStatus(json, workspaceId));
      } catch {
        if (!mountedRef.current) return;
        setStatus((s) => ({ ...s, isLoading: false }));
      }
    }

    void poll();
    const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [workspaceId]);

  return status;
}
