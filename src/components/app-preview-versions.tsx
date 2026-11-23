"use client";

import { ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { LoadingStatus } from "@/components/ui/loading-status";
import { appPreviewCatalogSchema } from "@/lib/app-preview-catalog";
import { appPreviewPrefix, hiveProductionOrigin } from "@/lib/app-preview-origin.mjs";

export function AppPreviewVersions() {
  const [supported, setSupported] = useState(false);
  const [previews, setPreviews] = useState<z.infer<typeof appPreviewCatalogSchema> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setSupported(window.location.origin === hiveProductionOrigin);
  }, []);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const result = await fetch("/api/app-previews", {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if ([401, 403].includes(result.status)) setPreviews(null);
      if (!result.ok) throw new Error("Preview catalog unavailable");
      setPreviews(appPreviewCatalogSchema.parse(await result.json()));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  if (!supported) return null;
  return (
    <details
      className="group rounded-md border bg-muted/15"
      onToggle={(event) => {
        if (event.currentTarget.open && previews === null && !loading && !error) void load();
      }}
    >
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm font-medium">
        <ChevronRight className="size-4 shrink-0 group-open:rotate-90" aria-hidden="true" />
        Preview versions
      </summary>
      <div className="space-y-3 border-t p-3">
        {loading && previews === null && <LoadingStatus>Checking preview versions…</LoadingStatus>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            Could not load preview versions.
          </p>
        )}
        {previews?.length === 0 && (
          <p className="text-sm text-muted-foreground">No pull request previews are ready.</p>
        )}
        {previews && previews.length > 0 && (
          <ul className="divide-y rounded-md border">
            {previews.map((preview) => (
              <li key={preview.slug}>
                {/* The launcher needs a new document with its own frame policy. */}
                <a
                  href={appPreviewPrefix + preview.slug}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-muted/50"
                >
                  <span className="min-w-0">
                    <span className="block break-words font-medium">
                      #{preview.number} {preview.title}
                    </span>
                    <span className="block break-all text-xs text-muted-foreground">
                      {preview.branch} · {preview.revision.slice(0, 8)}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        )}
        {(previews || error) && (
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
            {loading ? (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            {loading ? "Refreshing previews…" : error ? "Retry" : "Refresh previews"}
          </Button>
        )}
      </div>
    </details>
  );
}
