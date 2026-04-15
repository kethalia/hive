"use client";

import { useKeepAliveStatus } from "@/hooks/useKeepAliveStatus";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

interface KeepAliveWarningProps {
  workspaceId: string;
}

const FAILURE_THRESHOLD = 3;

export function KeepAliveWarning({ workspaceId }: KeepAliveWarningProps) {
  const { consecutiveFailures } = useKeepAliveStatus(workspaceId);

  if (consecutiveFailures < FAILURE_THRESHOLD) return null;

  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <AlertCircle className="size-4" />
      <AlertTitle>Keep-alive failure</AlertTitle>
      <AlertDescription>
        Keep-alive service cannot reach Coder API ({consecutiveFailures}{" "}
        consecutive failures). Your workspace may auto-stop if this continues.
      </AlertDescription>
    </Alert>
  );
}
