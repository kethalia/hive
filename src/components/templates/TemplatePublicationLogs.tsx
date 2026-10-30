"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { publicationBody } from "@/lib/templates/publication-io";
import {
  type TemplateLogResponse,
  templateLogResponseSchema,
} from "@/lib/templates/publication-log-contracts";

function readable(value: string) {
  return Array.from(value.replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
    })
    .join("");
}
async function responseValue(response: Response, signal: AbortSignal) {
  if (!response.ok) throw new Error("logs_unavailable");
  const bytes = await publicationBody(response, 524288, signal);
  return templateLogResponseSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

/** Explicit, memory-only human view. Never writes raw logs to the progress
 * terminal, storage, notifications, telemetry or an agent tool. */
export function TemplatePublicationLogs({ name, jobId }: { name: string; jobId: string }) {
  return <TemplatePublicationLogView key={`${name}/${jobId}`} name={name} jobId={jobId} />;
}
function TemplatePublicationLogView({ name, jobId }: { name: string; jobId: string }) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<TemplateLogResponse | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(false),
    [cursor, setCursor] = useState("0"),
    [history, setHistory] = useState<string[]>([]);
  const sequence = useRef(0),
    active = useRef<AbortController | null>(null),
    viewScope = useRef<string | null>(null);
  const close = useCallback(() => {
    sequence.current++;
    active.current?.abort();
    active.current = null;
    viewScope.current = null;
    setOpen(false);
    setPage(null);
    setLoading(false);
    setError(false);
    setCursor("0");
    setHistory([]);
  }, []);
  useEffect(() => {
    return () => {
      sequence.current++;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") close();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [close]);
  const load = async (after: string, previous: string[]) => {
    const id = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError(false);
    setPage(null);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(16000)]);
      const response = await fetch(
        `/api/templates/${encodeURIComponent(name)}/push/${encodeURIComponent(jobId)}/logs?after=${after}`,
        {
          credentials: "same-origin",
          cache: "no-store",
          signal,
        },
      );
      const next = await responseValue(response, signal);
      if (id !== sequence.current || controller.signal.aborted) return;
      const changed = viewScope.current !== null && viewScope.current !== next.viewScope;
      viewScope.current = next.viewScope;
      setPage(next);
      setCursor(after);
      setHistory(changed ? [] : previous.slice(-64));
    } catch {
      if (id === sequence.current && !controller.signal.aborted) {
        setError(true);
        setPage(null);
        viewScope.current = null;
        setHistory([]);
      }
    } finally {
      if (id === sequence.current) {
        setLoading(false);
        active.current = null;
      }
    }
  };
  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          void load("0", []);
        }}
      >
        View detailed logs
      </Button>
    );
  const blocked = page?.fallback === "malformed" || page?.fallback === "row_too_large";
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Detailed template logs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Detailed import logs</h3>
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          Close logs
        </Button>
      </div>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading logs…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Detailed logs are unavailable. Retry after checking your session.
        </p>
      ) : null}
      {page ? (
        <>
          <p className="text-sm text-muted-foreground">
            {page.available
              ? `Publication: ${page.stage.replaceAll("_", " ")}`
              : "Import logs are not available yet."}
          </p>
          {page.records.length ? (
            <section aria-label="Import log output">
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
                {page.records
                  .map(
                    (row) =>
                      `${row.stage ? `[${readable(row.stage)}] ` : ""}${readable(row.output)}`,
                  )
                  .join("\n")}
              </pre>
            </section>
          ) : page.available ? (
            <p className="text-sm text-muted-foreground">No complete log rows on this page.</p>
          ) : null}
          {page.fallback ? (
            <p className="text-sm text-muted-foreground">
              {blocked
                ? "A log row could not be displayed safely. Open Coder for the full output."
                : "This page reached its read limit. Continue from the last complete row or open Coder."}
            </p>
          ) : null}
          <a
            href={page.coderUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline"
          >
            Open logs in Coder
          </a>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !history.length}
          onClick={() => void load(history[history.length - 1], history.slice(0, -1))}
        >
          Previous page
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void load(cursor, history)}
        >
          Refresh page
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !page?.hasMore || blocked || page.nextAfter === cursor}
          onClick={() => {
            if (page) void load(page.nextAfter, [...history, cursor]);
          }}
        >
          Next page
        </Button>
      </div>
    </section>
  );
}
