"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CODER_OAUTH_POPUP_MESSAGE } from "@/lib/auth/coder-oauth-popup";

function showCoderPopupLoading(document: Document) {
  document.title = "Connecting to Coder · Hive";
  document.documentElement.lang = "en";

  // The initial about:blank document has none of Hive's styles or fonts.
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  const styles = document.createElement("style");
  styles.textContent = `
    :root { color-scheme: dark; background: #070a08; color: #dcffe3; font-family: ui-monospace, monospace; }
    body {
      box-sizing: border-box; margin: 0; min-height: 100vh; padding: 1rem;
      display: grid; place-items: center;
      background-image: linear-gradient(#8dff9d0a 1px, transparent 1px),
                        linear-gradient(90deg, #8dff9d0a 1px, transparent 1px);
      background-size: 2rem 2rem;
    }
    main {
      box-sizing: border-box; width: min(100%, 22rem); padding: 1.5rem;
      display: flex; align-items: center; gap: 1rem;
      border: 1px solid #8dff9d40; background: #0d130f;
      box-shadow: 0 0 3rem #8dff9d12;
    }
    main > span {
      display: grid; flex: 0 0 2.25rem; height: 2.25rem; place-items: center;
      border: 1px solid #8dff9d66; background: #8dff9d1a; color: #8dff9d;
      font-size: 0.875rem;
    }
    p { margin: 0; font-size: 0.9375rem; line-height: 1.5; }
    p::before {
      content: ""; display: inline-block; width: 0.75em; height: 0.75em;
      margin-inline-end: 0.65em; border: 1.5px solid #8dff9d;
      border-right-color: transparent; border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(1turn); } }
    @media (prefers-reduced-motion: reduce) { p::before { animation: none; } }
  `;
  document.head.append(viewport, styles);

  const panel = document.createElement("main");
  const mark = document.createElement("span");
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "H_";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Connecting to Coder…";
  panel.append(mark, status);
  document.body?.replaceChildren(panel);
}

async function readCoderSession(signal: AbortSignal): Promise<string | null> {
  const response = await fetch("/api/auth/coder/session", {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) throw Error("coder_session_unavailable");
  const body = await response.json();
  if (
    body.session !== null &&
    !(typeof body.session === "string" && /^[a-f0-9]{64}$/.test(body.session))
  )
    throw Error("coder_session_invalid");
  return body.session;
}

export function CoderOAuthLogin({ error: initialError = false }: { error?: boolean }) {
  const router = useRouter();
  const popupRef = useRef<Window | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const initialSessionRef = useRef<string | null | undefined>(undefined);
  const [attempt, setAttempt] = useState<string | null>(null);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const pending = attempt !== null || openingWorkspace;
  const [error, setError] = useState(
    initialError ? "Coder sign-in was interrupted. Please try again." : "",
  );
  useEffect(() => {
    if (!attempt) return;
    const popup = popupRef.current;
    const controller = requestRef.current;
    if (!popup || !controller) return;
    let settled = false;
    let checkingClosure = false;
    let verification: Promise<string | null> | null = null;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      setError(message);
      setAttempt(null);
    };
    const verifySession = async () => {
      const initial = initialSessionRef.current;
      if (initial === undefined || settled) return false;
      verification ??= readCoderSession(controller.signal).finally(() => {
        verification = null;
      });
      const current = await verification;
      if (settled || !current || current === initial) return false;
      settled = true;
      setOpeningWorkspace(true);
      setAttempt(null);
      router.replace("/workspaces");
      router.refresh();
      return true;
    };
    const completed = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== popup ||
        event.data?.type !== CODER_OAUTH_POPUP_MESSAGE ||
        event.data.attempt !== attempt ||
        typeof event.data.success !== "boolean"
      )
        return;
      const successfulResult = event.data.success;
      void verifySession()
        .then((authenticated) => {
          if (!authenticated && !successfulResult)
            fail("Coder sign-in did not complete. Please try again.");
        })
        .catch(() => {
          if (!successfulResult) fail("Could not verify Coder sign-in. Please try again.");
        });
    };
    window.addEventListener("message", completed);
    const verifyClosedSession = async () => {
      const pendingVerification = verification;
      if (pendingVerification) {
        // A pre-close request may have read cookies before the callback committed them.
        await pendingVerification.catch(() => {});
        if (settled) return;
      }
      if (!(await verifySession())) fail("The sign-in window was closed. Please try again.");
    };
    const closed = window.setInterval(() => {
      if (!popup.closed || checkingClosure || settled) return;
      checkingClosure = true;
      void verifyClosedSession().catch(() =>
        fail("Could not verify Coder sign-in. Refresh Hive or try again."),
      );
    }, 500);
    const sessionCheck = window.setInterval(() => {
      void verifySession().catch(() => {});
    }, 2_000);
    const expired = window.setTimeout(() => {
      fail("Coder sign-in expired. Please try again.");
    }, 600_000);
    return () => {
      settled = true;
      window.removeEventListener("message", completed);
      window.clearInterval(closed);
      window.clearInterval(sessionCheck);
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
    showCoderPopupLoading(popup.document);
    const controller = new AbortController();
    initialSessionRef.current = undefined;
    popupRef.current = popup;
    requestRef.current = controller;
    setAttempt(id);
    try {
      const initial = await readCoderSession(controller.signal);
      if (controller.signal.aborted || popup.closed) return;
      initialSessionRef.current = initial;
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
        {pending && (
          <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
        )}
        {openingWorkspace
          ? "Opening your workspace…"
          : pending
            ? "Connecting…"
            : "Continue with Coder"}
      </Button>
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          {openingWorkspace
            ? "Sign-in complete. Loading your workspace."
            : "Complete sign-in in the Coder window."}
        </p>
      )}
    </div>
  );
}
