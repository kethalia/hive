"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function CoderOAuthLogin({ error: initialError = false }: { error?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(
    initialError ? "Coder sign-in was interrupted. Please try again." : "",
  );
  async function signIn() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "coder" }),
        signal: AbortSignal.timeout(25_000),
      });
      const body = await response.json();
      if (!response.ok || typeof body.url !== "string") throw Error("coder_sign_in_failed");
      window.location.assign(body.url);
    } catch {
      setError("Coder sign-in could not start. Please try again.");
      setPending(false);
    }
  }
  return (
    <div className="space-y-5">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button className="min-h-11 w-full" onClick={() => void signIn()} disabled={pending}>
        {pending ? "Connecting…" : "Continue with Coder"}
      </Button>
    </div>
  );
}
