"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { LoadingStatus } from "@/components/ui/loading-status";

export function ReturnToHive() {
  return (
    <a href="/settings" className={buttonVariants({ size: "sm", variant: "outline" })}>
      Return to Hive
    </a>
  );
}

export function AppPreviewViewer({
  origin,
  number,
  branch,
}: {
  origin: string;
  number: number;
  branch: string;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const href = `${origin}/workspaces`;

  useEffect(() => {
    if (status === "ready") return;
    const timeout =
      status === "loading" ? window.setTimeout(() => setStatus("unavailable"), 20_000) : undefined;
    function ready(event: MessageEvent) {
      if (
        event.origin === origin &&
        event.source === iframe.current?.contentWindow &&
        event.data === "hive:preview-ready"
      ) {
        window.clearTimeout(timeout);
        setStatus("ready");
      }
    }
    window.addEventListener("message", ready);
    setMounted(true);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", ready);
    };
  }, [origin, status]);

  return (
    <main id="main-content" className="flex h-dvh flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b bg-background px-3 py-2">
        <h1 className="min-w-0 break-all text-sm font-medium">
          Preview #{number} <span className="text-muted-foreground">· {branch}</span>
        </h1>
        <div className="flex flex-wrap gap-2">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Open in browser <ExternalLink aria-hidden="true" />
          </a>
          <ReturnToHive />
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {mounted && (
          <iframe
            key={attempt}
            ref={iframe}
            title={`Hive preview #${number}`}
            src={href}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
            allow="clipboard-read; clipboard-write; microphone"
            className="size-full border-0"
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
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
