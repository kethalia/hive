"use client";

import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useKeepAliveStatus } from "@/hooks/useKeepAliveStatus";

interface KeepAliveWarningProps {
  workspaceId: string;
}

const FAILURE_THRESHOLD = 3;

export function KeepAliveWarning({ workspaceId }: KeepAliveWarningProps) {
  const { consecutiveFailures, lastFailureDetail, lastFailureReason, lastHttpStatus, status } =
    useKeepAliveStatus(workspaceId);

  if (status === "not-applicable" || consecutiveFailures < FAILURE_THRESHOLD) return null;

  const statusLabel = lastHttpStatus ? `HTTP ${lastHttpStatus}` : lastFailureReason;
  const diagnostic = lastFailureDetail || statusLabel;

  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <AlertCircle className="size-4" />
      <AlertTitle>Keep-alive failure</AlertTitle>
      <AlertDescription>
        Keep-alive service cannot reach Coder API ({consecutiveFailures} consecutive failures
        {statusLabel ? `, ${statusLabel}` : ""}). Your workspace may auto-stop if this continues.
        {diagnostic ? <span className="ml-1">{diagnostic}</span> : null}
        <Link
          className="ml-2 underline underline-offset-2"
          href={`/terminal/status?workspaceId=${encodeURIComponent(workspaceId)}`}
        >
          View terminal status
        </Link>
      </AlertDescription>
    </Alert>
  );
}
