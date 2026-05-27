"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import type { CSSProperties, PointerEvent } from "react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ComposePanel } from "@/components/terminal/ComposePanel";
import { HapticFloatingActionButton } from "@/components/terminal/HapticFloatingActionButton";
import { TerminalContextMenu } from "@/components/terminal/TerminalContextMenu";
import { TerminalGestureLayer } from "@/components/terminal/TerminalGestureLayer";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useFabKeyboardOffset } from "@/hooks/useFabKeyboardOffset";
import { useIsComposeSheet } from "@/hooks/use-compose-sheet";
import { useKeybindings } from "@/hooks/useKeybindings";
import { createSessionAction, getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import { COMPOSE_SHEET_DISMISS_DRAG_PX } from "@/lib/terminal/config";
import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";
import { copyTerminalSelection, pasteToTerminal } from "@/lib/terminal/actions";

const InteractiveTerminal = dynamic(
  () => import("@/components/workspaces/InteractiveTerminal").then((m) => m.InteractiveTerminal),
  { ssr: false },
);

const LAST_SESSION_STORAGE_PREFIX = "terminal:last-session:";
const TERMINAL_SHELL_CLASS_NAME =
  "-mx-6 -mb-[calc(var(--safe-area-inset-bottom)+1.5rem)] w-[calc(100%+3rem)]";
const TERMINAL_STATIC_HEIGHT_CLASS_NAME = "h-[calc(100dvh-var(--safe-area-inset-top)-3.5rem)]";

function terminalKeyboardStyle(keyboardLiftPx: number): CSSProperties {
  return {
    height: `calc(100dvh - var(--safe-area-inset-top) - 3.5rem - ${keyboardLiftPx}px)`,
  };
}

function terminalSessionHref(workspaceId: string, sessionName: string): string {
  return `/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(sessionName)}`;
}

function TerminalInner({ agentId, workspaceId }: { agentId: string; workspaceId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = searchParams.get("session");
  const { setActiveTerminal, activeTerminal, activeSend, register, unregister } = useKeybindings();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuSelection, setMenuSelection] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapRetryKey, setBootstrapRetryKey] = useState(0);
  const composeSheetDragStartYRef = useRef<number | null>(null);
  const isComposeSheet = useIsComposeSheet();
  const { liftPx: visualKeyboardLiftPx } = useFabKeyboardOffset();
  const keyboardLiftPx = isComposeSheet ? visualKeyboardLiftPx : 0;
  const terminalShellHeightClassName = isComposeSheet ? "" : TERMINAL_STATIC_HEIGHT_CLASS_NAME;
  const terminalShellStyle = isComposeSheet ? terminalKeyboardStyle(keyboardLiftPx) : undefined;

  const handleComposeSheetDragStart = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    composeSheetDragStartYRef.current = event.clientY;
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }, []);

  const handleComposeSheetDragEnd = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const startY = composeSheetDragStartYRef.current;
    composeSheetDragStartYRef.current = null;

    if (typeof event.currentTarget.releasePointerCapture === "function") {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (startY === null) return;
    if (event.clientY - startY >= COMPOSE_SHEET_DISMISS_DRAG_PX) {
      setComposeOpen(false);
    }
  }, []);

  const handleComposeSheetDragCancel = useCallback(() => {
    composeSheetDragStartYRef.current = null;
  }, []);

  const handleTerminalReady = useCallback(
    (term: import("@xterm/xterm").Terminal, send: (data: string) => void) => {
      setActiveTerminal(term, send);
    },
    [setActiveTerminal],
  );

  const handleTerminalDestroy = useCallback(() => {
    setActiveTerminal(null, null);
  }, [setActiveTerminal]);

  useEffect(() => {
    const binding = {
      id: "compose:toggle:fullscreen",
      keys: ["ctrl+`", "cmd+`"],
      action: () => {
        setComposeOpen((prev) => !prev);
        return false;
      },
      description: "Toggle compose panel",
      category: "terminal",
      enabledInBrowser: true,
    };
    register(binding);
    return () => unregister("compose:toggle:fullscreen");
  }, [register, unregister]);

  useEffect(() => {
    const handleComposeOpen = () => setComposeOpen(true);
    window.addEventListener(TERMINAL_COMPOSE_OPEN_EVENT, handleComposeOpen);
    return () => window.removeEventListener(TERMINAL_COMPOSE_OPEN_EVENT, handleComposeOpen);
  }, []);

  useEffect(() => {
    if (session) {
      try {
        window.localStorage.setItem(`${LAST_SESSION_STORAGE_PREFIX}${workspaceId}`, session);
      } catch {
        // Storage can be unavailable in hardened browser modes; session URL remains authoritative.
      }
      setBootstrapError(null);
      return;
    }

    let cancelled = false;
    setBootstrapError(null);
    console.log(
      `[workspaces] No session param for workspace ${workspaceId}, resolving terminal session (attempt ${bootstrapRetryKey + 1})`,
    );
    window.dispatchEvent(new CustomEvent("hive:sidebar-refresh", { detail: { workspaceId } }));

    async function resolveSession() {
      try {
        const sessionsResult = await getWorkspaceSessionsAction({ workspaceId });
        if (cancelled) return;

        if (sessionsResult?.data) {
          const sessions = sessionsResult.data;
          if (sessions.length > 0) {
            let preferred: string | null = null;
            try {
              preferred = window.localStorage.getItem(
                `${LAST_SESSION_STORAGE_PREFIX}${workspaceId}`,
              );
            } catch {
              preferred = null;
            }
            const selected = sessions.some((item) => item.name === preferred)
              ? preferred
              : sessions[0]?.name;
            if (selected) {
              router.replace(terminalSessionHref(workspaceId, selected));
              return;
            }
          }

          const created = await createSessionAction({ workspaceId });
          if (cancelled) return;
          if (created?.data?.name) {
            router.replace(terminalSessionHref(workspaceId, created.data.name));
            return;
          }
          setBootstrapError(created?.serverError ?? "Failed to create terminal session");
          return;
        }

        setBootstrapError(sessionsResult?.serverError ?? "Failed to load terminal sessions");
      } catch (error) {
        if (cancelled) return;
        setBootstrapError(
          error instanceof Error ? error.message : "Failed to load terminal sessions",
        );
      }
    }

    void resolveSession();

    return () => {
      cancelled = true;
    };
  }, [session, workspaceId, router, bootstrapRetryKey]);

  if (!session) {
    return (
      <div
        data-testid="terminal-bootstrap-shell"
        className={`${TERMINAL_SHELL_CLASS_NAME} ${terminalShellHeightClassName} flex items-center justify-center`}
        style={terminalShellStyle}
      >
        <div className="mx-6 max-w-sm rounded-2xl border bg-background/95 p-5 text-center shadow-lg">
          {bootstrapError ? (
            <>
              <p className="text-sm font-medium text-foreground">
                Could not load terminal sessions
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{bootstrapError}</p>
              <Button
                type="button"
                className="mt-4 min-h-11"
                onClick={() => setBootstrapRetryKey((value) => value + 1)}
              >
                Retry
              </Button>
            </>
          ) : (
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading terminal sessions…</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  const terminalPane = (
    <div
      className="h-full"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuSelection(!!activeTerminal?.getSelection());
        setMenuPosition({ x: e.clientX, y: e.clientY });
      }}
    >
      <TerminalGestureLayer
        onLongPress={(x, y) => {
          setMenuSelection(!!activeTerminal?.getSelection());
          setMenuPosition({ x, y });
        }}
      >
        <InteractiveTerminal
          key={session}
          agentId={agentId}
          workspaceId={workspaceId}
          sessionName={session}
          className="h-full rounded-none border-0"
          onTerminalReady={handleTerminalReady}
          onTerminalDestroy={handleTerminalDestroy}
        />
      </TerminalGestureLayer>
      <TerminalContextMenu
        position={menuPosition}
        onClose={() => setMenuPosition(null)}
        hasSelection={menuSelection}
        onCopy={() => {
          if (activeTerminal) copyTerminalSelection(activeTerminal);
        }}
        onPaste={() => {
          if (activeTerminal && activeSend) pasteToTerminal(activeTerminal, activeSend);
        }}
      />
    </div>
  );

  if (isComposeSheet) {
    return (
      <div
        data-testid="terminal-mobile-shell"
        className={`relative flex flex-col ${TERMINAL_SHELL_CLASS_NAME}`}
        style={terminalShellStyle}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="min-h-0 flex-1">{terminalPane}</div>
        <HapticFloatingActionButton />
        <Sheet open={composeOpen} onOpenChange={setComposeOpen}>
          <SheetContent
            side="bottom"
            className="h-[100dvh] max-h-[100dvh] p-0 pt-safe"
            style={{
              paddingBottom: `calc(var(--safe-area-inset-bottom) + ${keyboardLiftPx}px)`,
            }}
          >
            <button
              type="button"
              aria-label="Dismiss compose panel"
              className="mx-auto mt-2 flex h-11 w-20 touch-none items-center justify-center rounded-full text-muted-foreground hover:text-foreground active:cursor-grabbing"
              onClick={() => setComposeOpen(false)}
              onPointerCancel={handleComposeSheetDragCancel}
              onPointerDown={handleComposeSheetDragStart}
              onPointerUp={handleComposeSheetDragEnd}
            >
              <span className="h-1 w-10 rounded-full bg-current opacity-40" />
            </button>
            <SheetTitle className="sr-only">Compose command</SheetTitle>
            <div className="min-h-0 flex-1">
              <ComposePanel hideHeader onClose={() => setComposeOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div
      data-testid="terminal-desktop-shell"
      className={`${TERMINAL_SHELL_CLASS_NAME} ${TERMINAL_STATIC_HEIGHT_CLASS_NAME}`}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <ResizablePanelGroup orientation="vertical" className="h-full">
        <ResizablePanel defaultSize={composeOpen ? 75 : 100} minSize={30}>
          {terminalPane}
        </ResizablePanel>
        {composeOpen && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={25} minSize={10} maxSize={50}>
              <ComposePanel onClose={() => setComposeOpen(false)} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <HapticFloatingActionButton />
    </div>
  );
}

interface TerminalClientProps {
  agentId: string;
  workspaceId: string;
}

export function TerminalClient({ agentId, workspaceId }: TerminalClientProps) {
  return (
    <Suspense
      fallback={
        <div
          data-testid="terminal-suspense-shell"
          className={`${TERMINAL_SHELL_CLASS_NAME} ${TERMINAL_STATIC_HEIGHT_CLASS_NAME} flex items-center justify-center`}
        >
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <TerminalInner agentId={agentId} workspaceId={workspaceId} />
    </Suspense>
  );
}
