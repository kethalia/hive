"use client";

import { Download, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { usePwaStandalone } from "@/lib/terminal/pwa";

const DISMISS_KEY = "hive:pwa-install-prompt-dismissed";

type BeforeInstallPromptChoice = {
  outcome: "accepted" | "dismissed";
  platform: string;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<BeforeInstallPromptChoice>;
};

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "true";
  } catch {
    return true;
  }
}

function persistDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "true");
  } catch {
    // Ignore storage failures; the in-memory dismissal still applies.
  }
}

export function PwaInstallPrompt() {
  const isStandalone = usePwaStandalone();
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed());
    setReady(true);
  }, []);

  useEffect(() => {
    if (isStandalone) return;

    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, [isStandalone]);

  const dismiss = useCallback(() => {
    persistDismissed();
    setDismissed(true);
  }, []);

  const install = useCallback(async () => {
    if (!installEvent) return;
    setInstalling(true);
    try {
      await installEvent.prompt();
      await installEvent.userChoice;
      dismiss();
      setInstallEvent(null);
    } finally {
      setInstalling(false);
    }
  }, [dismiss, installEvent]);

  if (!ready || isStandalone || dismissed) return null;

  return (
    <div className="fixed right-4 bottom-4 left-4 z-50 pb-safe sm:right-auto sm:w-[28rem]">
      <Alert className="relative shadow-lg">
        <div className="flex items-center gap-2 pr-8">
          <Download className="size-4 shrink-0" />
          <AlertTitle>Install Hive as an app</AlertTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            onClick={dismiss}
            aria-label="Dismiss install app prompt"
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <AlertDescription className="mt-1 pr-2 text-sm">
          {installEvent ? (
            <span>
              Add Hive to your desktop for a standalone window and app-only keyboard shortcuts.
            </span>
          ) : (
            <span>
              Install from your browser menu: Chrome or Edge → Install app; Safari on macOS → File →
              Add to Dock; iPhone or iPad → Share → Add to Home Screen.
            </span>
          )}
        </AlertDescription>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={dismiss}>
            Later
          </Button>
          {installEvent && (
            <Button size="xs" onClick={install} disabled={installing}>
              {installing ? "Installing…" : "Install app"}
            </Button>
          )}
        </div>
      </Alert>
    </div>
  );
}
