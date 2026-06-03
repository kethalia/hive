"use client";

import type { Terminal } from "@xterm/xterm";
import { AlertCircle, ClipboardPaste, Copy, Loader2, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useKeybindings } from "@/hooks/useKeybindings";
import { createSessionAction, getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import { isTextSelectionEvent, NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import {
  type ClipboardActionStatus,
  copyTerminalSelection,
  pasteToTerminal,
} from "@/lib/terminal/actions";
import { cn } from "@/lib/utils";
import {
  createCascadedFloatingGeometry,
  deriveRetiledSessionPaneLayout,
  FLOATING_PANE_MIN_HEIGHT,
  FLOATING_PANE_MIN_WIDTH,
  type FloatingPaneGeometry,
  type PersistedSessionPane,
  resolveSessionPaneLayout,
  SESSION_PANE_LAYOUT_VERSION,
  type SessionPane,
  type SessionPaneContainerRect,
  type SessionPaneLayout,
  type SessionPaneLayoutDiagnostic,
} from "@/lib/workspaces/session-pane-layout";

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

type LayoutPersistenceNotice = {
  code: "storage-unavailable" | "storage-write-failed" | "storage-reset-failed";
  message: string;
};

type FloatingPaneGestureKind = "drag" | "resize";

type FloatingPaneGesture = {
  kind: FloatingPaneGestureKind;
  sessionName: string;
  pointerId: number;
  originClientX: number;
  originClientY: number;
  startGeometry: FloatingPaneGeometry;
  previewGeometry: FloatingPaneGeometry;
};

type FloatingPaneGesturePreview = {
  sessionName: string;
  geometry: FloatingPaneGeometry;
};

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

function storageKeyForWorkspace(workspaceId: string): string {
  return `multi-session-layout:${workspaceId}`;
}

function readWorkspaceLayoutStorage(storageKey: string): {
  raw: string | null;
  notice: LayoutPersistenceNotice | null;
} {
  if (typeof window === "undefined") return { raw: null, notice: null };

  try {
    return { raw: window.localStorage.getItem(storageKey), notice: null };
  } catch {
    return {
      raw: null,
      notice: {
        code: "storage-unavailable",
        message: "Layout persistence is unavailable. Safe tiled layout is active.",
      },
    };
  }
}

function parsePersistedActiveSessionName(persistedJson: string | null): string | null {
  if (!persistedJson) return null;

  try {
    const parsed = JSON.parse(persistedJson) as unknown;
    if (!isObjectRecord(parsed)) return null;
    return normalizeSessionName(parsed.activeSessionName);
  } catch {
    return null;
  }
}

function readElementContainerRect(element: HTMLElement | null): SessionPaneContainerRect | null {
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  const width = rect.width || element.clientWidth || window.innerWidth;
  const height = rect.height || element.clientHeight || window.innerHeight;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function sameContainerRect(
  left: SessionPaneContainerRect | null,
  right: SessionPaneContainerRect | null,
): boolean {
  return (
    (left?.width ?? null) === (right?.width ?? null) &&
    (left?.height ?? null) === (right?.height ?? null)
  );
}

function geometryFromFloatingPane(
  pane: Extract<SessionPane, { mode: "floating" }>,
): FloatingPaneGeometry {
  return {
    x: pane.x,
    y: pane.y,
    width: pane.width,
    height: pane.height,
    zIndex: pane.zIndex,
  };
}

function clampFloatingPaneGeometry(
  geometry: FloatingPaneGeometry,
  container: SessionPaneContainerRect | null,
): FloatingPaneGeometry {
  const width = finiteClampedInteger(
    geometry.width,
    FLOATING_PANE_MIN_WIDTH,
    Math.max(1, Math.trunc(container?.width ?? geometry.width)),
  );
  const height = finiteClampedInteger(
    geometry.height,
    FLOATING_PANE_MIN_HEIGHT,
    Math.max(1, Math.trunc(container?.height ?? geometry.height)),
  );
  const maxX = Math.max(0, Math.trunc(container?.width ?? width) - width);
  const maxY = Math.max(0, Math.trunc(container?.height ?? height) - height);

  return {
    x: finiteClampedInteger(geometry.x, 0, maxX),
    y: finiteClampedInteger(geometry.y, 0, maxY),
    width,
    height,
    zIndex: Math.max(0, Math.trunc(geometry.zIndex)),
  };
}

function finiteClampedInteger(value: number, min: number, max: number): number {
  const safeMax = Math.max(min, Math.trunc(max));
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), safeMax);
}

function toPersistedPane(
  pane: SessionPane,
  override?: { mode: "tiled" } | { mode: "floating"; geometry: FloatingPaneGeometry },
): PersistedSessionPane {
  if (override?.mode === "floating") {
    return {
      sessionName: pane.sessionName,
      mode: "floating",
      order: pane.order,
      geometry: override.geometry,
    };
  }

  if (override?.mode === "tiled") {
    return {
      sessionName: pane.sessionName,
      mode: "tiled",
      order: pane.order,
    };
  }

  if (pane.mode === "floating") {
    return {
      sessionName: pane.sessionName,
      mode: "floating",
      order: pane.order,
      geometry: geometryFromFloatingPane(pane),
    };
  }

  return {
    sessionName: pane.sessionName,
    mode: "tiled",
    order: pane.order,
  };
}

function serializeWorkspacePaneLayout(
  panes: readonly PersistedSessionPane[],
  activeSessionName: string | null,
): string {
  return JSON.stringify({
    version: SESSION_PANE_LAYOUT_VERSION,
    activeSessionName: activeSessionName ?? undefined,
    panes,
  });
}

function serializeResolvedWorkspacePaneLayout(
  layout: SessionPaneLayout,
  activeSessionName: string | null,
): string {
  return serializeWorkspacePaneLayout(
    layout.panes.map((pane) => toPersistedPane(pane)),
    activeSessionName,
  );
}

function buildLayoutPersistenceMessage(
  notice: LayoutPersistenceNotice | null,
  diagnostics: readonly SessionPaneLayoutDiagnostic[],
): string | null {
  if (notice) return notice.message;
  if (diagnostics.length === 0) return null;

  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code));
  if (codes.has("persisted-json-invalid") || codes.has("persisted-layout-malformed")) {
    return "Stored pane layout could not be read. Safe tiled layout is active; use Reset layout to clear it.";
  }
  if (codes.has("persisted-version-unsupported")) {
    return "Stored pane layout uses an unsupported version. Safe tiled layout is active; use Reset layout to clear it.";
  }
  if (codes.has("container-invalid")) {
    return "Floating pane layout is waiting for a valid workspace size. Safe tiled layout is active.";
  }
  if (codes.has("pane-geometry-repaired")) {
    return "Stored floating pane geometry was repaired to fit this workspace.";
  }
  if (codes.has("stale-pane-dropped")) {
    return "Stored panes for sessions that are no longer open were ignored.";
  }

  return "Stored pane layout was recovered with safe defaults.";
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
  const [persistedLayoutJson, setPersistedLayoutJson] = useState<string | null>(null);
  const [layoutPersistenceNotice, setLayoutPersistenceNotice] =
    useState<LayoutPersistenceNotice | null>(null);
  const [containerRect, setContainerRect] = useState<SessionPaneContainerRect | null>(null);
  const [gesturePreview, setGesturePreview] = useState<FloatingPaneGesturePreview | null>(null);
  const terminalsRef = useRef<Map<string, TerminalEntry>>(new Map());
  const activeSessionNameRef = useRef<string | null>(null);
  const activeGestureRef = useRef<FloatingPaneGesture | null>(null);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);

  activeSessionNameRef.current = activeSessionName;

  const layout = useMemo(
    () =>
      resolveSessionPaneLayout({
        sessions: sessions.map((session) => ({
          sessionName: session.sessionName,
          label: session.label,
        })),
        persistedJson: persistedLayoutJson,
        container: containerRect,
      }),
    [containerRect, persistedLayoutJson, sessions],
  );
  const activeEntry = activeSessionName ? terminalsRef.current.get(activeSessionName) : undefined;
  const activeLabel = sessions.find((session) => session.sessionName === activeSessionName)?.label;
  const clipboardMessage = clipboardStatusText(clipboardActionStatus);
  const layoutPersistenceMessage = buildLayoutPersistenceMessage(
    layoutPersistenceNotice,
    layout.diagnostics,
  );
  const layoutPersistenceCodes = [
    ...(layoutPersistenceNotice ? [layoutPersistenceNotice.code] : []),
    ...layout.diagnostics.map((diagnostic) => diagnostic.code),
  ].join(" ");

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

  const persistLayoutJson = useCallback(
    (nextLayoutJson: string | null) => {
      const storageKey = storageKeyForWorkspace(workspaceId);
      setPersistedLayoutJson(nextLayoutJson);

      if (typeof window === "undefined") return;

      try {
        if (nextLayoutJson === null) {
          window.localStorage.removeItem(storageKey);
        } else {
          window.localStorage.setItem(storageKey, nextLayoutJson);
        }
        setLayoutPersistenceNotice(null);
      } catch {
        setLayoutPersistenceNotice({
          code: nextLayoutJson === null ? "storage-reset-failed" : "storage-write-failed",
          message:
            nextLayoutJson === null
              ? "Layout storage could not be cleared. Safe controls remain available."
              : "Layout changes are active for this view but could not be saved locally.",
        });
      }
    },
    [workspaceId],
  );

  const handleFloatPane = useCallback(
    (sessionName: string) => {
      const floatingCount = layout.panes.filter((pane) => pane.mode === "floating").length;
      const panes = layout.panes.map((pane) => {
        if (pane.sessionName !== sessionName) return toPersistedPane(pane);
        const geometry =
          pane.mode === "floating"
            ? geometryFromFloatingPane(pane)
            : createCascadedFloatingGeometry(floatingCount, containerRect);
        return toPersistedPane(pane, { mode: "floating", geometry });
      });
      persistLayoutJson(serializeWorkspacePaneLayout(panes, sessionName));
      selectSession(sessionName);
    },
    [containerRect, layout.panes, persistLayoutJson, selectSession],
  );

  const handleTilePane = useCallback(
    (sessionName: string) => {
      const panes = layout.panes.map((pane) =>
        pane.sessionName === sessionName
          ? toPersistedPane(pane, { mode: "tiled" })
          : toPersistedPane(pane),
      );
      persistLayoutJson(serializeWorkspacePaneLayout(panes, sessionName));
      selectSession(sessionName);
    },
    [layout.panes, persistLayoutJson, selectSession],
  );

  const handleResetLayout = useCallback(() => {
    persistLayoutJson(null);
  }, [persistLayoutJson]);

  const handleRetileLayout = useCallback(() => {
    const retiledLayout = deriveRetiledSessionPaneLayout(layout);
    persistLayoutJson(
      serializeResolvedWorkspacePaneLayout(retiledLayout, activeSessionNameRef.current),
    );
  }, [layout, persistLayoutJson]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual retry trigger for session loading
  useEffect(() => {
    let cancelled = false;
    const storageKey = storageKeyForWorkspace(workspaceId);
    const storedLayout = readWorkspaceLayoutStorage(storageKey);
    const storedActiveSessionName = parsePersistedActiveSessionName(storedLayout.raw);

    setLoading(true);
    setLoadFailed(false);
    setCreateFailed(false);
    setClipboardActionStatus(null);
    setSessions([]);
    setActiveSessionName(null);
    setPersistedLayoutJson(storedLayout.raw);
    setLayoutPersistenceNotice(storedLayout.notice);
    terminalsRef.current.clear();
    clearActiveTerminal();

    async function loadSessions() {
      try {
        const result = await getWorkspaceSessionsAction({ workspaceId });
        if (cancelled) return;

        const parsed = parseSessionsResult(result);
        if (parsed.status === "success") {
          setSessions(parsed.sessions);
          const restoredActiveSession = parsed.sessions.find(
            (session) => session.sessionName === storedActiveSessionName,
          );
          setActiveSessionName(
            restoredActiveSession?.sessionName ?? parsed.sessions[0].sessionName,
          );
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

  useEffect(() => {
    if (loading || sessions.length === 0) return;

    const element = workspaceBodyRef.current;
    if (!element) return;

    const measure = (nextRect = readElementContainerRect(element)) => {
      setContainerRect((current) => (sameContainerRect(current, nextRect) ? current : nextRect));
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        measure();
        return;
      }
      const { width, height } = entry.contentRect;
      measure(width > 0 && height > 0 ? { width, height } : readElementContainerRect(element));
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [loading, sessions.length]);

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

  const commitFloatingPaneGeometry = useCallback(
    (sessionName: string, geometry: FloatingPaneGeometry) => {
      const panes = layout.panes.map((pane) =>
        pane.sessionName === sessionName
          ? toPersistedPane(pane, { mode: "floating", geometry })
          : toPersistedPane(pane),
      );
      persistLayoutJson(serializeWorkspacePaneLayout(panes, sessionName));
    },
    [layout.panes, persistLayoutJson],
  );

  const resolveCurrentGestureContainer = useCallback(
    () => readElementContainerRect(workspaceBodyRef.current) ?? containerRect,
    [containerRect],
  );

  const deriveGestureGeometry = useCallback(
    (gesture: FloatingPaneGesture, clientX: number, clientY: number): FloatingPaneGeometry => {
      const deltaX = clientX - gesture.originClientX;
      const deltaY = clientY - gesture.originClientY;
      const container = resolveCurrentGestureContainer();

      if (gesture.kind === "resize") {
        return clampFloatingPaneGeometry(
          {
            ...gesture.startGeometry,
            width: gesture.startGeometry.width + deltaX,
            height: gesture.startGeometry.height + deltaY,
          },
          container,
        );
      }

      return clampFloatingPaneGeometry(
        {
          ...gesture.startGeometry,
          x: gesture.startGeometry.x + deltaX,
          y: gesture.startGeometry.y + deltaY,
        },
        container,
      );
    },
    [resolveCurrentGestureContainer],
  );

  const finishFloatingPaneGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = activeGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      const finalGeometry = deriveGestureGeometry(gesture, event.clientX, event.clientY);
      activeGestureRef.current = null;
      setGesturePreview(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopPropagation();
      selectSession(gesture.sessionName);
      commitFloatingPaneGeometry(gesture.sessionName, finalGeometry);
    },
    [commitFloatingPaneGeometry, deriveGestureGeometry, selectSession],
  );

  const handleFloatingPanePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = activeGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      const geometry = deriveGestureGeometry(gesture, event.clientX, event.clientY);
      activeGestureRef.current = { ...gesture, previewGeometry: geometry };
      setGesturePreview({ sessionName: gesture.sessionName, geometry });
      event.preventDefault();
      event.stopPropagation();
    },
    [deriveGestureGeometry],
  );

  const startFloatingPaneGesture = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      pane: Extract<SessionPane, { mode: "floating" }>,
      kind: FloatingPaneGestureKind,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      selectSession(pane.sessionName);

      if (
        event.button !== 0 ||
        event.isPrimary === false ||
        isTextSelectionEvent(event.nativeEvent)
      ) {
        activeGestureRef.current = null;
        setGesturePreview(null);
        return;
      }

      const container = readElementContainerRect(workspaceBodyRef.current);
      if (!container) {
        activeGestureRef.current = null;
        setGesturePreview(null);
        return;
      }

      const maxZIndex = layout.panes.reduce((max, candidate) => {
        if (candidate.mode !== "floating") return max;
        return Math.max(max, candidate.zIndex);
      }, 0);
      const startGeometry = clampFloatingPaneGeometry(
        { ...geometryFromFloatingPane(pane), zIndex: Math.max(pane.zIndex, maxZIndex + 1) },
        container,
      );
      const gesture: FloatingPaneGesture = {
        kind,
        sessionName: pane.sessionName,
        pointerId: event.pointerId,
        originClientX: event.clientX,
        originClientY: event.clientY,
        startGeometry,
        previewGeometry: startGeometry,
      };

      activeGestureRef.current = gesture;
      setGesturePreview({ sessionName: pane.sessionName, geometry: startGeometry });
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [layout.panes, selectSession],
  );

  const renderPane = (pane: SessionPane) => {
    const isActive = pane.sessionName === activeSessionName;
    const previewGeometry =
      pane.mode === "floating" && gesturePreview?.sessionName === pane.sessionName
        ? gesturePreview.geometry
        : null;
    const layoutSignal =
      pane.mode === "floating"
        ? `floating:${pane.width}:${pane.height}`
        : `${layout.tiled.rows}:${layout.tiled.columns}:${pane.gridArea}`;
    let paneStyle: CSSProperties;
    if (pane.mode === "floating") {
      const renderedGeometry = previewGeometry ?? pane;
      paneStyle = {
        left: renderedGeometry.x,
        top: renderedGeometry.y,
        width: renderedGeometry.width,
        height: renderedGeometry.height,
        zIndex: renderedGeometry.zIndex,
      };
    } else {
      paneStyle = { gridArea: pane.gridArea };
    }

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
          pane.mode === "floating" ? "absolute" : "",
          isActive ? "border-primary ring-1 ring-primary" : "border-border",
        )}
        data-testid={`workspace-${pane.id}`}
        data-active={isActive ? "true" : "false"}
        data-pane-mode={pane.mode}
        style={paneStyle}
        tabIndex={0}
        onClick={() => selectSession(pane.sessionName)}
        onFocus={() => selectSession(pane.sessionName)}
        onPointerMove={pane.mode === "floating" ? handleFloatingPanePointerMove : undefined}
        onPointerUp={pane.mode === "floating" ? finishFloatingPaneGesture : undefined}
        onPointerCancel={pane.mode === "floating" ? finishFloatingPaneGesture : undefined}
        onLostPointerCapture={pane.mode === "floating" ? finishFloatingPaneGesture : undefined}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectSession(pane.sessionName);
          }
        }}
      >
        <div className="flex min-h-11 items-center gap-2 border-b border-white/10 bg-zinc-950 px-2 py-1 text-white">
          {pane.mode === "floating" ? (
            <div
              aria-label={`Drag ${pane.label}`}
              className="flex min-h-11 min-w-11 flex-1 cursor-move items-center gap-2 overflow-hidden touch-none"
              data-testid={`drag-handle-${pane.id}`}
              role="presentation"
              style={NO_TOUCH_STYLE}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => startFloatingPaneGesture(event, pane, "drag")}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{pane.label}</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/80">
                {isActive ? "Active" : "Inactive"}
              </span>
            </div>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{pane.label}</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/80">
                {isActive ? "Active" : "Inactive"}
              </span>
            </>
          )}
          {pane.mode === "floating" ? (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="min-h-11 min-w-11 px-2 text-xs"
              aria-label={`Tile ${pane.label}`}
              data-testid={`tile-pane-${pane.id}`}
              onClick={(event) => {
                event.stopPropagation();
                handleTilePane(pane.sessionName);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              Tile
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="min-h-11 min-w-11 px-2 text-xs"
              aria-label={`Float ${pane.label}`}
              data-testid={`float-pane-${pane.id}`}
              onClick={(event) => {
                event.stopPropagation();
                handleFloatPane(pane.sessionName);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              Float
            </Button>
          )}
        </div>
        <InteractiveTerminal
          agentId={agentId}
          workspaceId={workspaceId}
          sessionName={pane.sessionName}
          className="h-[calc(100%-2.75rem)]"
          layoutSignal={layoutSignal}
          onTerminalReady={(term, send) => handleTerminalReady(pane.sessionName, term, send)}
          onTerminalDestroy={() => handleTerminalDestroy(pane.sessionName)}
        />
        {pane.mode === "floating" ? (
          <div
            aria-label={`Resize ${pane.label}`}
            className="absolute bottom-0 right-0 flex min-h-11 min-w-11 cursor-nwse-resize items-end justify-end touch-none p-1 text-white/70"
            data-testid={`resize-handle-${pane.id}`}
            role="presentation"
            style={NO_TOUCH_STYLE}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => startFloatingPaneGesture(event, pane, "resize")}
          >
            <span aria-hidden="true" className="text-xs leading-none">
              ◢
            </span>
          </div>
        ) : null}
      </div>
    );
  };

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
          onClick={handleResetLayout}
          className="min-h-11 min-w-11"
          aria-label="Reset layout"
          data-testid="reset-layout"
        >
          Reset layout
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRetileLayout}
          className="min-h-11 min-w-11"
          aria-label="Retile panes"
          data-testid="retile-layout"
        >
          Retile
        </Button>
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

      {layoutPersistenceMessage ? (
        <p
          className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
          data-layout-codes={layoutPersistenceCodes}
          data-testid="layout-persistence-status"
        >
          {layoutPersistenceMessage}
        </p>
      ) : null}

      {clipboardMessage ? (
        <p className="px-3 py-1 text-xs text-muted-foreground" data-testid="clipboard-status">
          {clipboardMessage}
        </p>
      ) : null}

      <div
        ref={workspaceBodyRef}
        className="relative min-h-0 flex-1 overflow-hidden p-2"
        data-testid="multi-session-body"
      >
        <div
          className="grid h-full min-h-0 gap-2"
          style={{
            gridTemplateColumns: layout.tiled.gridTemplateColumns,
            gridTemplateRows: layout.tiled.gridTemplateRows,
          }}
          data-testid="multi-session-grid"
        >
          {layout.panes.filter((pane) => pane.mode === "tiled").map(renderPane)}
        </div>
        <div className="absolute inset-0 pointer-events-none" data-testid="floating-pane-layer">
          {layout.panes
            .filter((pane) => pane.mode === "floating")
            .map((pane) => (
              <div key={pane.id} className="pointer-events-auto contents">
                {renderPane(pane)}
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}
