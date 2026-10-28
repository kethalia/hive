"use client";

import { Download, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { checkAppVersion, refreshInstalledApp } from "@/lib/app-update";
import { APP_VERSION, type AppVersion, hasAppUpdate } from "@/lib/app-version";

export function AppUpdateSettings() {
  const [deployed, setDeployed] = useState<AppVersion | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState<"checking" | "updating" | null>(null);
  const [error, setError] = useState("");
  const available = deployed !== null && hasAppUpdate(APP_VERSION, deployed);

  async function check() {
    setBusy("checking");
    setError("");
    setDeployed(null);
    try {
      setDeployed(await checkAppVersion());
      setCheckedAt(new Date());
    } catch {
      setError("Could not check for updates. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function update() {
    setBusy("updating");
    setError("");
    try {
      // Verify the deployment is reachable before interrupting the current page.
      await checkAppVersion();
      await refreshInstalledApp();
    } catch {
      setError("Could not update Hive. Check your connection and try again.");
      setBusy(null);
    }
  }

  return (
    <div className="@container space-y-5">
      <dl className="grid min-w-0 gap-4 text-sm @sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <dt className="text-muted-foreground">Current version</dt>
          <dd className="break-words font-medium">{APP_VERSION.version}</dd>
          <dd className="break-all text-xs text-muted-foreground">Build {APP_VERSION.buildId}</dd>
        </div>
        <div className="min-w-0 space-y-1">
          <dt className="text-muted-foreground">Latest deployed version</dt>
          <dd className="break-words font-medium">{deployed?.version ?? "Not checked"}</dd>
          {deployed ? (
            <dd className="break-all text-xs text-muted-foreground">Build {deployed.buildId}</dd>
          ) : null}
        </div>
      </dl>
      <div className="space-y-1 text-sm" role="status" aria-live="polite">
        <p>
          {busy === "checking"
            ? "Checking for updates…"
            : busy === "updating"
              ? "Updating Hive…"
              : deployed
                ? available
                  ? "An app update is available."
                  : "You're up to date."
                : "Check for the latest version available on this Hive server."}
        </p>
        {checkedAt ? (
          <p className="text-xs text-muted-foreground">Last checked {checkedAt.toLocaleString()}</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="h-auto min-h-10 max-w-full whitespace-normal py-2"
          disabled={busy !== null}
          onClick={() => void check()}
        >
          {busy === "checking" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Check for updates
        </Button>
        <Button
          className="h-auto min-h-10 max-w-full whitespace-normal py-2"
          disabled={!available || busy !== null}
          onClick={() => void update()}
        >
          {busy === "updating" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Update app
        </Button>
      </div>
      <p className="max-w-3xl text-xs text-muted-foreground">
        Updating reloads this app and reconnects your terminals. Your workspace sessions keep
        running.
      </p>
    </div>
  );
}
