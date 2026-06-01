"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import type { PointerEvent } from "react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ComposePanel } from "@/components/terminal/ComposePanel";
import { MobileTerminalControls } from "@/components/terminal/MobileTerminalControls";
import { MobileTerminalDiagnosticsOverlay } from "@/components/terminal/MobileTerminalDiagnosticsOverlay";
import { MobileTerminalShell } from "@/components/terminal/MobileTerminalShell";
import { TerminalContextMenu } from "@/components/terminal/TerminalContextMenu";
import { TerminalGestureLayer } from "@/components/terminal/TerminalGestureLayer";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsComposeSheet } from "@/hooks/use-compose-sheet";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useVisualViewportKeyboardOffset } from "@/hooks/useVisualViewportKeyboardOffset";
import { createSessionAction, getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import { triggerHapticFeedback } from "@/lib/device/haptics";
import { copyTerminalSelection, pasteToTerminal } from "@/lib/terminal/actions";
import { COMPOSE_SHEET_DISMISS_DRAG_PX } from "@/lib/terminal/config";
import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";
import { composeSheetKeyboardStyle } from "@/lib/terminal/mobile-shell-layout";

const InteractiveTerminal = dynamic(
  () => import("@/components/workspaces/InteractiveTerminal").then((m) => m.InteractiveTerminal),
  { ssr: false },
);

const LAST_SESSION_STORAGE_PREFIX = "terminal:last-session:";
const TERMINAL_WIDTH_CLASS_NAME = "-mx-6 w-[calc(100%+3rem)]";
const TERMINAL_STATIC_HEIGHT_CLASS_NAME =
  "h-[calc(var(--app-viewport-height)-var(--safe-area-inset-top)-3.5rem)]";

function terminalSessionHref(
  workspaceId: string,
  sessionName: string,
  debugViewport = false,
): string {
  const href = `/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(sessionName)}`;
  return debugViewport ? `${href}&debugViewport=1` : href;
}

function TerminalInner({ agentId, workspaceId }: { agentId: string; workspaceId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = searchParams.get("session");
  const clonePath = session ? searchParams.get("clonePath") || undefined : undefined;
  const cloneProof = session && clonePath ? searchParams.get("cloneProof") || undefined : undefined;
  const debugViewportEnabled = searchParams.get("debugViewport") === "1";
  const { setActiveTerminal, activeTerminal, activeSend, register, unregister } = useKeybindings();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuSelection, setMenuSelection] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapRetryKey, setBootstrapRetryKey] = useState(0);
  const composeSheetDragStartYRef = useRef<number | null>(null);
  const isComposeSheet = useIsComposeSheet();
  const {
    liftPx: visualKeyboardLiftPx,
    isKeyboardVisible: visualKeyboardVisible = false,
    visualViewportHeightPx = 0,
    visualViewportOffsetTopPx = 0,
  } = useVisualViewportKeyboardOffset();
  const isMobileKeyboardVisible = isComposeSheet && visualKeyboardVisible;
  const keyboardLiftPx = isComposeSheet ? visualKeyboardLiftPx : 0;
  const composeSheetStyle = composeSheetKeyboardStyle(isMobileKeyboardVisible);
  const mobileLayoutSignal = isMobileKeyboardVisible
    ? `keyboard:${visualViewportHeightPx}:${visualViewportOffsetTopPx}`
    : `lift:${keyboardLiftPx}`;

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
              router.replace(terminalSessionHref(workspaceId, selected, debugViewportEnabled));
              return;
            }
          }

          const created = await createSessionAction({ workspaceId });
          if (cancelled) return;
          if (created?.data?.name) {
            router.replace(
              terminalSessionHref(workspaceId, created.data.name, debugViewportEnabled),
            );
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
  }, [session, workspaceId, router, bootstrapRetryKey, debugViewportEnabled]);

  if (!session) {
    const bootstrapCard = (
      <div className="mx-6 max-w-sm rounded-2xl border bg-background/95 p-5 text-center shadow-lg">
        {bootstrapError ? (
          <>
            <p className="text-sm font-medium text-foreground">Could not load terminal sessions</p>
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
    );

    if (isComposeSheet) {
      return (
        <MobileTerminalShell
          className="items-center justify-center"
          diagnosticsEnabled={debugViewportEnabled}
          isKeyboardVisible={isMobileKeyboardVisible}
        >
          {bootstrapCard}
        </MobileTerminalShell>
      );
    }

    return (
      <div
        data-testid="terminal-bootstrap-shell"
        className={`${TERMINAL_WIDTH_CLASS_NAME} ${TERMINAL_STATIC_HEIGHT_CLASS_NAME} flex items-center justify-center`}
      >
        {bootstrapCard}
      </div>
    );
  }

  const terminalPane = (
    <div
      className="h-full"
      data-terminal-surface="true"
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
          clonePath={clonePath}
          cloneProof={cloneProof}
          className="h-full rounded-none border-0"
          onTerminalReady={handleTerminalReady}
          onTerminalDestroy={handleTerminalDestroy}
          layoutSignal={mobileLayoutSignal}
          mobileInputMode={isComposeSheet}
          pinToBottomOnResize={isComposeSheet}
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
      <MobileTerminalShell
        diagnosticsEnabled={debugViewportEnabled}
        isKeyboardVisible={isMobileKeyboardVisible}
      >
        <div className="flex h-full min-h-0 flex-col overflow-hidden overscroll-none bg-background">
          <section
            aria-label="Terminal emulator"
            className="min-h-0 flex-1 overflow-hidden bg-black"
            data-terminal-surface="true"
          >
            {terminalPane}
          </section>
          <MobileTerminalControls
            isKeyboardVisible={isMobileKeyboardVisible}
            onHapticFeedback={triggerHapticFeedback}
          />
        </div>
        <Sheet open={composeOpen} onOpenChange={setComposeOpen}>
          <SheetContent
            side="bottom"
            className="h-[var(--app-viewport-height)] max-h-[var(--app-viewport-height)] p-0 pt-safe"
            style={composeSheetStyle}
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
      </MobileTerminalShell>
    );
  }

  return (
    <div
      data-testid="terminal-desktop-shell"
      data-terminal-shell="true"
      className={`${TERMINAL_WIDTH_CLASS_NAME} ${TERMINAL_STATIC_HEIGHT_CLASS_NAME}`}
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
      <MobileTerminalDiagnosticsOverlay enabled={debugViewportEnabled} />
    </div>
  );
}

interface TerminalClientProps {
  agentId: string;
  agentName?: string;
  workspaceId: string;
}

export function TerminalClient({ agentId, workspaceId }: TerminalClientProps) {
  return (
    <Suspense
      fallback={
        <div
          data-testid="terminal-suspense-shell"
          className={`${TERMINAL_WIDTH_CLASS_NAME} ${TERMINAL_STATIC_HEIGHT_CLASS_NAME} flex items-center justify-center`}
        >
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <TerminalInner agentId={agentId} workspaceId={workspaceId} />
    </Suspense>
  );
}
