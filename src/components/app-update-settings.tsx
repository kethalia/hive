"use client";

import { ChevronRight, Download, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { AppPreviewVersions } from "@/components/app-preview-versions";
import { Button } from "@/components/ui/button";
import { checkAppVersion, refreshInstalledApp } from "@/lib/app-update";
import { APP_VERSION, type AppVersion, hasAppUpdate } from "@/lib/app-version";

export function AppUpdateSettings() {
  const [deployed, setDeployed] = useState<AppVersion | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [busy, setBusy] = useState<"checking" | "updating" | null>(null);
  const [error, setError] = useState("");
  const available = deployed !== null && hasAppUpdate(APP_VERSION, deployed);

  async function check() {
    setBusy("checking");
    setError("");

    try {
      setDeployed(await checkAppVersion());
      setCheckedAt(new Date());
      setCheckFailed(false);
    } catch {
      setCheckFailed(true);
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
    <div className="space-y-3">
      <div className="divide-y rounded-md border bg-muted/15">
        <dl className="divide-y text-sm">
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 px-3 py-2.5">
            <dt>Installed</dt>
            <dd className="break-all font-medium">{APP_VERSION.version}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 px-3 py-2.5">
            <dt>{available ? "Available" : "Latest"}</dt>
            <dd className="break-all font-medium">{deployed?.version ?? "Not checked"}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-start justify-between gap-2 p-2.5">
          <details className="group min-w-0 flex-1 basis-28">
            <summary className="flex min-h-10 cursor-pointer items-center gap-1.5 px-1 text-sm text-muted-foreground">
              <ChevronRight className="size-4 shrink-0 group-open:rotate-90" aria-hidden="true" />
              Build details
            </summary>
            <dl className="space-y-1 px-1 pb-1 text-xs">
              <dt className="text-muted-foreground">Installed build</dt>
              <dd className="break-all">{APP_VERSION.buildId}</dd>
              {deployed && (
                <>
                  <dt className="text-muted-foreground">Latest build</dt>
                  <dd className="break-all">{deployed.buildId}</dd>
                </>
              )}
              {checkedAt && (
                <>
                  <dt className="text-muted-foreground">Last checked</dt>
                  <dd>{checkedAt.toLocaleString()}</dd>
                </>
              )}
            </dl>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="h-auto min-h-10 max-w-full whitespace-normal py-2"
              disabled={busy !== null}
              onClick={() => void check()}
            >
              {busy === "checking" ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw className="size-4" aria-hidden="true" />
              )}
              {busy === "checking" ? "Checking…" : "Check for updates"}
            </Button>
            <Button
              className="h-auto min-h-10 max-w-full whitespace-normal py-2"
              disabled={!available || checkFailed || busy !== null}
              onClick={() => void update()}
            >
              {busy === "updating" ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
              {busy === "updating" ? "Updating…" : "Update app"}
            </Button>
          </div>
        </div>
      </div>
      {deployed && !checkFailed && (
        <p role="status" className="text-sm text-muted-foreground">
          {available ? "An app update is available." : "You're up to date."}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {available && !checkFailed && (
        <p className="text-xs text-muted-foreground">
          Updating reloads Hive. Your workspace sessions keep running.
        </p>
      )}
      <AppPreviewVersions />
    </div>
  );
}
