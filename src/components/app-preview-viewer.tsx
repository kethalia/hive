"use client";

import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { LoadingStatus } from "@/components/ui/loading-status";
import { type AppPreview, isAppPreviewDeployed } from "@/lib/app-preview-catalog";
import { appPreviewOrigin, appPreviewProductionMessage } from "@/lib/app-preview-origin.mjs";

export function ProductionLink() {
  return (
    <a href="/settings" className={buttonVariants({ size: "sm", variant: "outline" })}>
      Production
    </a>
  );
}

export function AppPreviewViewer({ preview }: { preview: AppPreview }) {
  const { slug, number, branch, revision } = preview;
  const origin = appPreviewOrigin(slug);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [verifiedAttempt, setVerifiedAttempt] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const href = `${origin}/workspaces`;

  useEffect(() => {
    const controller = new AbortController();
    void isAppPreviewDeployed({ slug, branch, revision }, controller.signal).then((deployed) => {
      if (controller.signal.aborted) return;
      if (deployed) setVerifiedAttempt(attempt);
      else setStatus("unavailable");
    });
    return () => controller.abort();
  }, [attempt, slug, branch, revision]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== origin || event.source !== iframe.current?.contentWindow) return;
      if (event.data === "hive:preview-ready") setStatus("ready");
      if (event.data === appPreviewProductionMessage) window.location.replace("/settings");
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [origin]);

  useEffect(() => {
    if (status !== "loading") return;
    const timeout = window.setTimeout(() => setStatus("unavailable"), 20_000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  return (
    <main id="main-content" className="relative h-dvh">
      {verifiedAttempt === attempt && (
        <iframe
          key={attempt}
          ref={iframe}
          title={`Hive preview #${number}`}
          src={href}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
          allow="clipboard-read; clipboard-write; microphone"
          className="block size-full border-0"
          inert={status !== "ready"}
        />
      )}
      {status !== "ready" && (
        <div className="absolute inset-0 grid place-content-center gap-3 bg-background p-6 text-center">
          {status === "loading" ? (
            <LoadingStatus>Opening preview…</LoadingStatus>
          ) : (
            <>
              <p role="alert">Could not open this build inside Hive.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setStatus("loading");
                    setAttempt((value) => value + 1);
                  }}
                >
                  Retry
                </Button>
                <ProductionLink />
              </div>
            </>
          )}
        </div>
      )}
    </main>
  );
}
