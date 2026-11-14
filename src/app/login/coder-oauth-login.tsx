"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CODER_OAUTH_POPUP_MESSAGE } from "@/lib/auth/coder-oauth-popup";

export function CoderOAuthLogin({ error: initialError = false }: { error?: boolean }) {
  const router = useRouter();
  const popupRef = useRef<Window | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);
  const pending = attempt !== null;
  const [error, setError] = useState(
    initialError ? "Coder sign-in was interrupted. Please try again." : "",
  );
  useEffect(() => {
    if (!attempt) return;
    const popup = popupRef.current;
    const controller = requestRef.current;
    const completed = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== popup ||
        event.data?.type !== CODER_OAUTH_POPUP_MESSAGE ||
        event.data.attempt !== attempt ||
        typeof event.data.success !== "boolean"
      )
        return;
      setAttempt(null);
      if (event.data.success) {
        router.replace("/workspaces");
        router.refresh();
      } else setError("Coder sign-in did not complete. Please try again.");
    };
    window.addEventListener("message", completed);
    const closed = window.setInterval(() => {
      if (popup?.closed) {
        setError("The sign-in window was closed. Please try again.");
        setAttempt(null);
      }
    }, 500);
    const expired = window.setTimeout(() => {
      setError("Coder sign-in expired. Please try again.");
      setAttempt(null);
    }, 600_000);
    return () => {
      window.removeEventListener("message", completed);
      window.clearInterval(closed);
      window.clearTimeout(expired);
      controller?.abort();
      if (popup && !popup.closed) popup.close();
      if (popupRef.current === popup) popupRef.current = null;
    };
  }, [attempt, router]);

  async function signIn() {
    setError("");
    const id = crypto.randomUUID();
    const popup = window.open("about:blank", `hive-coder-${id}`, "popup,width=560,height=720");
    if (!popup) {
      setError("Allow pop-ups for Hive, then try signing in again.");
      return;
    }
    popup.document.title = "Connecting to Coder";
    if (popup.document.body) popup.document.body.textContent = "Connecting to Coder…";
    const controller = new AbortController();
    popupRef.current = popup;
    requestRef.current = controller;
    setAttempt(id);
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "coder", popup: id }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
      });
      const body = await response.json();
      if (!response.ok || typeof body.url !== "string") throw Error("coder_sign_in_failed");
      if (!controller.signal.aborted && !popup.closed) popup.location.replace(body.url);
    } catch {
      if (controller.signal.aborted) return;
      setError("Coder sign-in could not start. Please try again.");
      setAttempt(null);
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
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          Complete sign-in in the Coder window.
        </p>
      )}
    </div>
  );
}
