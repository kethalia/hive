"use client";

import { useEffect } from "react";
import { CODER_OAUTH_POPUP_MESSAGE } from "@/lib/auth/coder-oauth-popup";

export function CoderOAuthComplete({
  attempt,
  success,
}: {
  attempt: string | null;
  success: boolean;
}) {
  useEffect(() => {
    if (!attempt || !window.opener) return;
    window.opener.postMessage(
      { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success },
      window.location.origin,
    );
    window.close();
  }, [attempt, success]);

  return (
    <div className="space-y-4">
      <p role="status">
        {success ? "Coder sign-in is complete." : "Coder sign-in did not complete."}
      </p>
      <p className="text-sm text-muted-foreground">
        Return to your original Hive window. If it has not updated, refresh it to continue.
      </p>
      <a className="text-sm underline" href={success ? "/workspaces" : "/login"}>
        {success ? "Open Hive" : "Try signing in again"}
      </a>
    </div>
  );
}
