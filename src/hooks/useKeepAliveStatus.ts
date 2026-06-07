"use client";

import { useEffect, useRef, useState } from "react";
import { getClientRuntimeConfig } from "@/lib/runtime-config";

export type KeepAliveHealthStatus = "healthy" | "failing" | "no-token" | "recently-disconnected";

export type KeepAliveFailureCategory =
  | "http-auth"
  | "http-client"
  | "http-server"
  | "timeout"
  | "network"
  | "unknown";

export interface KeepAliveStatus {
  status: KeepAliveHealthStatus;
  consecutiveFailures: number;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastFailureCategory: KeepAliveFailureCategory | null;
  activeConnectionCount: number;
  lastDisconnectedAt: string | null;
  isLoading: boolean;
}

const POLL_INTERVAL_MS = 30_000;
const KEEP_ALIVE_HEALTH_STATUSES = new Set<KeepAliveHealthStatus>([
  "healthy",
  "failing",
  "no-token",
  "recently-disconnected",
]);
const KEEP_ALIVE_FAILURE_CATEGORIES = new Set<KeepAliveFailureCategory>([
  "http-auth",
  "http-client",
  "http-server",
  "timeout",
  "network",
  "unknown",
]);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const DEFAULT_KEEP_ALIVE_STATUS: KeepAliveStatus = {
  status: "healthy",
  consecutiveFailures: 0,
  lastAttempt: null,
  lastSuccess: null,
  lastFailure: null,
  lastFailureCategory: null,
  activeConnectionCount: 0,
  lastDisconnectedAt: null,
  isLoading: true,
};

function wsUrlToHttp(wsUrl: string): string {
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

function parseCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function parseWorkspaceStatus(payload: unknown, workspaceId: string): KeepAliveStatus {
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
    activeConnectionCount: parseCount(workspace.activeConnectionCount),
    lastDisconnectedAt: parseTimestamp(workspace.lastDisconnectedAt),
    isLoading: false,
  };
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

    const baseUrl = wsUrlToHttp(proxyWsUrl);

    async function poll() {
      try {
        const res = await fetch(`${baseUrl}/keepalive/status`);
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
