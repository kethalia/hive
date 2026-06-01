"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type MobileViewportDiagnosticsSnapshot,
  sampleMobileViewportDiagnostics,
} from "@/lib/terminal/mobile-viewport-diagnostics";
import { cn } from "@/lib/utils";

const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

type MobileTerminalDiagnosticsOverlayProps = {
  enabled: boolean;
  className?: string;
  sampleIntervalMs?: number;
  sampler?: () => MobileViewportDiagnosticsSnapshot;
};

function formatNumber(value: number | null | undefined, suffix = "") {
  return typeof value === "number" ? `${value}${suffix}` : "—";
}

function formatRect(rect: MobileViewportDiagnosticsSnapshot["terminal"]["shellRect"]) {
  if (!rect) return "missing";
  return `${rect.width}×${rect.height} at ${rect.x},${rect.y}`;
}

function formatRowsCols(rows: number | null | undefined, cols: number | null | undefined) {
  if (typeof rows !== "number" || typeof cols !== "number") return "missing";
  return `${rows} rows × ${cols} cols`;
}

function formatEventTime(value: number | null | undefined) {
  return typeof value === "number" ? `${value}` : "—";
}

function formatTerminalEvent(
  label: "fit" | "resize request" | "resize sent",
  event: MobileViewportDiagnosticsSnapshot["terminal"]["fit"],
) {
  if (event.count <= 0 && !event.lastAt && !event.lastSource) return "missing";
  return `${label}: ${event.lastSource ?? "unknown source"} @ ${formatEventTime(
    event.lastAt,
  )} (${formatRowsCols(event.rows, event.cols)}, count ${event.count})`;
}

function formatLatestLocalResizeEvent(terminal: MobileViewportDiagnosticsSnapshot["terminal"]) {
  const fitAt = terminal.fit.lastAt ?? -1;
  const requestAt = terminal.resizeRequest.lastAt ?? -1;

  if (fitAt < 0 && requestAt < 0) return "missing";
  return requestAt >= fitAt
    ? formatTerminalEvent("resize request", terminal.resizeRequest)
    : formatTerminalEvent("fit", terminal.fit);
}

function DiagnosticsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 border-border/50 border-t py-1.5 first:border-t-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-foreground text-xs">{value}</dd>
    </div>
  );
}

export function MobileTerminalDiagnosticsOverlay({
  enabled,
  className,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  sampler = sampleMobileViewportDiagnostics,
}: MobileTerminalDiagnosticsOverlayProps) {
  const [snapshot, setSnapshot] = useState<MobileViewportDiagnosticsSnapshot | null>(null);
  const [copyStatus, setCopyStatus] = useState<string>("");

  useEffect(() => {
    if (!enabled) return;

    const sample = () => setSnapshot(sampler());
    sample();
    const interval = window.setInterval(sample, sampleIntervalMs);
    return () => window.clearInterval(interval);
  }, [enabled, sampleIntervalMs, sampler]);

  const jsonReport = useMemo(() => (snapshot ? JSON.stringify(snapshot, null, 2) : ""), [snapshot]);

  if (!enabled) return null;

  const copyReport = async () => {
    if (!jsonReport) return;

    try {
      await navigator.clipboard.writeText(jsonReport);
      setCopyStatus("Copied diagnostics JSON");
    } catch {
      setCopyStatus("Copy failed");
    }
  };

  return (
    <aside
      aria-label="Mobile terminal diagnostics"
      className={cn(
        "fixed right-3 bottom-3 z-50 max-h-[min(32rem,calc(100dvh-2rem))] w-[min(26rem,calc(100vw-1.5rem))] overflow-auto rounded-2xl border border-amber-400/30 bg-zinc-950/95 p-3 text-amber-50 text-xs shadow-2xl shadow-black/40 backdrop-blur",
        className,
      )}
      data-testid="mobile-terminal-diagnostics-overlay"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-sm">Mobile viewport diagnostics</h2>
          <p className="text-amber-100/70">
            Geometry only. Terminal text and input values are excluded.
          </p>
        </div>
        <Button
          aria-label="Copy diagnostics JSON report"
          className="min-h-11 border-amber-300/30 bg-amber-300/10 px-3 text-amber-50 hover:bg-amber-300/20"
          disabled={!snapshot}
          size="sm"
          type="button"
          variant="outline"
          onClick={copyReport}
        >
          Copy JSON
        </Button>
      </div>

      {snapshot ? (
        <div className="space-y-3">
          <section aria-labelledby="mobile-diagnostics-viewport">
            <h3 className="mb-1 font-medium text-amber-100" id="mobile-diagnostics-viewport">
              Viewport
            </h3>
            <dl>
              <DiagnosticsRow
                label="Layout"
                value={`${formatNumber(snapshot.viewport.layout.width, "px")} × ${formatNumber(
                  snapshot.viewport.layout.height,
                  "px",
                )}`}
              />
              <DiagnosticsRow
                label="Visual"
                value={
                  snapshot.viewport.visual
                    ? `${formatNumber(snapshot.viewport.visual.width, "px")} × ${formatNumber(
                        snapshot.viewport.visual.height,
                        "px",
                      )}`
                    : "missing"
                }
              />
              <DiagnosticsRow
                label="Offset top"
                value={formatNumber(snapshot.viewport.visual?.offsetTop, "px")}
              />
              <DiagnosticsRow
                label="Page top"
                value={formatNumber(snapshot.viewport.visual?.pageTop, "px")}
              />
              <DiagnosticsRow
                label="Keyboard inset"
                value={formatNumber(snapshot.viewport.keyboardInsetBottom, "px")}
              />
            </dl>
          </section>

          <section aria-labelledby="mobile-diagnostics-terminal">
            <h3 className="mb-1 font-medium text-amber-100" id="mobile-diagnostics-terminal">
              Terminal geometry
            </h3>
            <dl>
              <DiagnosticsRow label="Shell" value={formatRect(snapshot.terminal.shellRect)} />
              <DiagnosticsRow
                label="Helper textarea"
                value={formatRect(snapshot.terminal.helperTextareaRect)}
              />
              <DiagnosticsRow
                label="Active element"
                value={snapshot.activeElement?.tagName ?? "none"}
              />
              <DiagnosticsRow
                label="Xterm size"
                value={formatRowsCols(snapshot.terminal.xterm.rows, snapshot.terminal.xterm.cols)}
              />
              <DiagnosticsRow
                label="Latest resize"
                value={formatLatestLocalResizeEvent(snapshot.terminal)}
              />
              <DiagnosticsRow
                label="WS resize sent"
                value={formatTerminalEvent("resize sent", snapshot.terminal.resizeSent)}
              />
            </dl>
          </section>
        </div>
      ) : (
        <p className="text-amber-100/70">Collecting first diagnostics sample…</p>
      )}

      <p aria-live="polite" className="mt-3 min-h-4 text-amber-100/70">
        {copyStatus}
      </p>
    </aside>
  );
}
