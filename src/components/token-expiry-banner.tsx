import type { TokenStatusResult } from "@hive/auth";
import { AlertCircle, Clock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function TokenExpiryBanner({ status }: { status: TokenStatusResult }) {
  if (status.status === "valid") {
    return null;
  }

  if (status.status === "expired") {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Token Expired</AlertTitle>
        <AlertDescription>
          Your Coder API token has expired. Please log out and log in again to continue.
        </AlertDescription>
      </Alert>
    );
  }

  if (status.status === "key_mismatch") {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Re-authentication Required</AlertTitle>
        <AlertDescription>
          The encryption key has changed. Please log out and log in again.
        </AlertDescription>
      </Alert>
    );
  }

  if (status.status === "expiring") {
    const hoursLeft = status.expiresAt
      ? Math.max(0, Math.round((status.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60)))
      : 0;

    return (
      <Alert variant="default">
        <Clock />
        <AlertTitle>Token Expiring Soon</AlertTitle>
        <AlertDescription>
          Your Coder API token will expire in {hoursLeft} {hoursLeft === 1 ? "hour" : "hours"}.
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}
