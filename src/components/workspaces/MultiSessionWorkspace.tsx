"use client";

import type { Terminal } from "@xterm/xterm";
import { AlertCircle, ClipboardPaste, Copy, Loader2, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useKeybindings } from "@/hooks/useKeybindings";
import { createSessionAction, getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import {
  type ClipboardActionStatus,
  copyTerminalSelection,
  pasteToTerminal,
} from "@/lib/terminal/actions";
import { cn } from "@/lib/utils";
import { computeSmartTiledLayout } from "@/lib/workspaces/tiled-layout";

interface InteractiveTerminalComponentProps {
  agentId: string;
  workspaceId: string;
  sessionName: string;
  className?: string;
  onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
  onTerminalDestroy?: () => void;
  layoutSignal?: unknown;
}

const InteractiveTerminal = dynamic<InteractiveTerminalComponentProps>(
  () => import("@/components/workspaces/InteractiveTerminal").then((m) => m.InteractiveTerminal),
  { ssr: false },
);

interface WorkspaceSessionPane {
  sessionName: string;
  label: string;
}

interface TerminalEntry {
  term: Terminal;
  send: (data: string) => void;
}

interface MultiSessionWorkspaceProps {
  agentId: string;
  workspaceId: string;
  className?: string;
}

type SessionLoadResult =
  | { status: "success"; sessions: WorkspaceSessionPane[] }
  | { status: "empty" }
  | { status: "failure" };

type CreateResult = { status: "success"; session: WorkspaceSessionPane } | { status: "failure" };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeSessionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSessionItem(value: unknown): WorkspaceSessionPane | null {
  if (!isObjectRecord(value)) return null;
  const sessionName = normalizeSessionName(value.name ?? value.sessionName);
  if (!sessionName) return null;
  return { sessionName, label: sessionName };
}

function isWorkspaceSessionPane(value: WorkspaceSessionPane | null): value is WorkspaceSessionPane {
  return value !== null;
}

function uniqueSessions(values: readonly WorkspaceSessionPane[]): WorkspaceSessionPane[] {
  const seen = new Set<string>();
  const unique: WorkspaceSessionPane[] = [];

  for (const value of values) {
    if (seen.has(value.sessionName)) continue;
    seen.add(value.sessionName);
    unique.push(value);
  }

  return unique;
}

function parseSessionsResult(result: unknown): SessionLoadResult {
  if (!isObjectRecord(result)) return { status: "failure" };
  if (result.serverError || result.validationErrors) return { status: "failure" };
  if (!Array.isArray(result.data)) return { status: "failure" };

  const sessions = uniqueSessions(
    result.data.map(normalizeSessionItem).filter(isWorkspaceSessionPane),
  );
  return sessions.length > 0 ? { status: "success", sessions } : { status: "empty" };
}

function parseCreateResult(result: unknown): CreateResult {
  if (!isObjectRecord(result)) return { status: "failure" };
  if (result.serverError || result.validationErrors) return { status: "failure" };
  if (!isObjectRecord(result.data)) return { status: "failure" };

  const sessionName = normalizeSessionName(result.data.name ?? result.data.sessionName);
  if (!sessionName) return { status: "failure" };
  return { status: "success", session: { sessionName, label: sessionName } };
}

function clipboardStatusText(status: ClipboardActionStatus | null): string | null {
  if (!status) return null;

  if (status.action === "copy") {
    if (status.outcome === "copied") return "Copy complete.";
    if (status.outcome === "failed") return "Copy failed. Use the browser clipboard controls.";
    return "No terminal selection to copy.";
  }

  if (status.outcome === "pasted") return "Paste complete.";
  if (status.outcome === "empty") return "Clipboard was empty.";
  return "Paste fallback was attempted.";
}

export function MultiSessionWorkspace({
  agentId,
  workspaceId,
  className,
}: MultiSessionWorkspaceProps) {
  const { setActiveTerminal } = useKeybindings();
  const [sessions, setSessions] = useState<WorkspaceSessionPane[]>([]);
  const [activeSessionName, setActiveSessionName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [clipboardActionStatus, setClipboardActionStatus] = useState<ClipboardActionStatus | null>(
    null,
  );
  const terminalsRef = useRef<Map<string, TerminalEntry>>(new Map());
  const activeSessionNameRef = useRef<string | null>(null);

  activeSessionNameRef.current = activeSessionName;

  const layout = useMemo(
    () =>
      computeSmartTiledLayout(
        sessions.map((session) => ({ sessionName: session.sessionName, label: session.label })),
      ),
    [sessions],
  );
  const activeEntry = activeSessionName ? terminalsRef.current.get(activeSessionName) : undefined;
  const activeLabel = sessions.find((session) => session.sessionName === activeSessionName)?.label;
  const clipboardMessage = clipboardStatusText(clipboardActionStatus);

  const clearActiveTerminal = useCallback(() => {
    setActiveTerminal(null, null);
  }, [setActiveTerminal]);

  const selectSession = useCallback(
    (sessionName: string) => {
      setActiveSessionName(sessionName);
      setClipboardActionStatus(null);
      const entry = terminalsRef.current.get(sessionName);
      if (entry) {
        setActiveTerminal(entry.term, entry.send);
        return;
      }
      clearActiveTerminal();
    },
    [clearActiveTerminal, setActiveTerminal],
  );

  const handleTerminalReady = useCallback(
    (sessionName: string, term: Terminal, send: (data: string) => void) => {
      terminalsRef.current.set(sessionName, { term, send });
      if (activeSessionNameRef.current === sessionName) {
        setActiveTerminal(term, send);
      }
    },
    [setActiveTerminal],
  );

  const handleTerminalDestroy = useCallback(
    (sessionName: string) => {
      terminalsRef.current.delete(sessionName);
      if (activeSessionNameRef.current === sessionName) {
        clearActiveTerminal();
      }
    },
    [clearActiveTerminal],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual retry trigger for session loading
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setCreateFailed(false);
    setClipboardActionStatus(null);
    setSessions([]);
    setActiveSessionName(null);
    terminalsRef.current.clear();
    clearActiveTerminal();

    async function loadSessions() {
      try {
        const result = await getWorkspaceSessionsAction({ workspaceId });
        if (cancelled) return;

        const parsed = parseSessionsResult(result);
        if (parsed.status === "success") {
          setSessions(parsed.sessions);
          setActiveSessionName(parsed.sessions[0].sessionName);
          return;
        }

        if (parsed.status === "empty") {
          setSessions([]);
          setActiveSessionName(null);
          return;
        }

        setLoadFailed(true);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSessions();

    return () => {
      cancelled = true;
      terminalsRef.current.clear();
      clearActiveTerminal();
    };
  }, [clearActiveTerminal, reloadKey, workspaceId]);

  const handleCreateSession = useCallback(async () => {
    setCreating(true);
    setCreateFailed(false);
    setClipboardActionStatus(null);

    try {
      const result = await createSessionAction({ workspaceId });
      const parsed = parseCreateResult(result);
      if (parsed.status === "failure") {
        setCreateFailed(true);
        return;
      }

      setSessions((current) => uniqueSessions([...current, parsed.session]));
      selectSession(parsed.session.sessionName);
      window.dispatchEvent(new CustomEvent("hive:sidebar-refresh", { detail: { workspaceId } }));
    } catch {
      setCreateFailed(true);
    } finally {
      setCreating(false);
    }
  }, [selectSession, workspaceId]);

  const handleCopyActivePane = useCallback(() => {
    const entry = activeSessionNameRef.current
      ? terminalsRef.current.get(activeSessionNameRef.current)
      : undefined;
    if (!entry) return;
    copyTerminalSelection(entry.term, { onStatus: setClipboardActionStatus });
  }, []);

  const handlePasteActivePane = useCallback(() => {
    const entry = activeSessionNameRef.current
      ? terminalsRef.current.get(activeSessionNameRef.current)
      : undefined;
    if (!entry) return;
    pasteToTerminal(entry.term, entry.send, { onStatus: setClipboardActionStatus });
  }, []);

  if (loading) {
    return (
      <div
        className={cn("flex h-full items-center justify-center bg-background", className)}
        data-testid="multi-session-loading"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading terminal sessions…
        </div>
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-4 bg-background px-6 text-center",
          className,
        )}
      >
        <Alert variant="destructive" data-testid="session-load-error" className="max-w-md">
          <AlertCircle />
          <AlertTitle>Could not load terminal sessions.</AlertTitle>
          <AlertDescription>
            Retry to inspect workspace sessions. Existing terminals were not mounted from stale
            data.
          </AlertDescription>
        </Alert>
        <Button
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
          data-testid="retry-load-sessions"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-4 bg-background px-6 text-center",
          className,
        )}
        data-testid="multi-session-empty"
      >
        <p className="text-sm font-medium text-foreground">No terminal sessions open</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Create a tmux-backed terminal session for this workspace.
        </p>
        {createFailed ? (
          <Alert variant="destructive" data-testid="session-create-error" className="max-w-md">
            <AlertCircle />
            <AlertTitle>Could not create a terminal session.</AlertTitle>
            <AlertDescription>
              Retry creation; no clipboard or terminal contents were logged.
            </AlertDescription>
          </Alert>
        ) : null}
        <Button
          type="button"
          onClick={handleCreateSession}
          disabled={creating}
          data-testid="create-empty-session-button"
        >
          <Plus className="size-4" />
          {creating ? "Creating…" : "Create session"}
        </Button>
      </div>
    );
  }

  return (
    <section
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
      data-testid="multi-session-workspace"
      aria-label="Multi-session terminal workspace"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Active pane</p>
          <p className="truncate font-mono text-sm" data-testid="active-pane-label">
            {activeLabel ?? "No active pane"}
          </p>
        </div>
        <span className="sr-only" data-testid="multi-session-pane-count">
          {sessions.length}
        </span>
        <nav className="flex max-w-full gap-1 overflow-x-auto" aria-label="Select terminal pane">
          {layout.panes.map((pane) => {
            const isActive = pane.sessionName === activeSessionName;
            return (
              <Button
                key={pane.id}
                type="button"
                variant={isActive ? "secondary" : "ghost"}
                size="xs"
                onClick={() => selectSession(pane.sessionName)}
                data-testid={`select-pane-${pane.id}`}
              >
                {pane.label}
              </Button>
            );
          })}
        </nav>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopyActivePane}
          disabled={!activeEntry}
          data-testid="copy-active-pane"
        >
          <Copy className="size-3.5" />
          Copy
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handlePasteActivePane}
          disabled={!activeEntry}
          data-testid="paste-active-pane"
        >
          <ClipboardPaste className="size-3.5" />
          Paste
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleCreateSession}
          disabled={creating}
          data-testid="create-session-button"
        >
          <Plus className="size-3.5" />
          {creating ? "Creating…" : "New pane"}
        </Button>
      </header>

      {createFailed ? (
        <Alert variant="destructive" data-testid="session-create-error" className="m-3 mb-0">
          <AlertCircle />
          <AlertTitle>Could not create a terminal session.</AlertTitle>
          <AlertDescription>
            Existing panes remain mounted and selected state is unchanged.
          </AlertDescription>
        </Alert>
      ) : null}

      {clipboardMessage ? (
        <p className="px-3 py-1 text-xs text-muted-foreground" data-testid="clipboard-status">
          {clipboardMessage}
        </p>
      ) : null}

      <div
        className="grid min-h-0 flex-1 gap-2 p-2"
        style={{
          gridTemplateColumns: layout.gridTemplateColumns,
          gridTemplateRows: layout.gridTemplateRows,
        }}
        data-testid="multi-session-grid"
      >
        {layout.panes.map((pane) => {
          const isActive = pane.sessionName === activeSessionName;
          return (
            // biome-ignore lint/a11y/useSemanticElements: selectable tile wraps a terminal surface, so a native button would be invalid
            <div
              key={pane.id}
              aria-label={`Terminal pane ${pane.label}`}
              aria-current={isActive ? "true" : undefined}
              aria-pressed={isActive}
              role="button"
              className={cn(
                "min-h-0 overflow-hidden rounded-xl border bg-black shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                isActive ? "border-primary ring-1 ring-primary" : "border-border",
              )}
              data-testid={`workspace-${pane.id}`}
              data-active={isActive ? "true" : "false"}
              style={{ gridArea: pane.gridArea }}
              tabIndex={0}
              onClick={() => selectSession(pane.sessionName)}
              onFocus={() => selectSession(pane.sessionName)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectSession(pane.sessionName);
                }
              }}
            >
              <div className="flex items-center gap-2 border-b border-white/10 bg-zinc-950 px-2 py-1 text-white">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{pane.label}</span>
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/80">
                  {isActive ? "Active" : "Inactive"}
                </span>
              </div>
              <InteractiveTerminal
                agentId={agentId}
                workspaceId={workspaceId}
                sessionName={pane.sessionName}
                className="h-[calc(100%-2rem)]"
                layoutSignal={`${layout.rows}:${layout.columns}:${pane.gridArea}`}
                onTerminalReady={(term, send) => handleTerminalReady(pane.sessionName, term, send)}
                onTerminalDestroy={() => handleTerminalDestroy(pane.sessionName)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
