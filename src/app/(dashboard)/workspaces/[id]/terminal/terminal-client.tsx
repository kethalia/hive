"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import type { PointerEvent } from "react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ComposePanel } from "@/components/terminal/ComposePanel";
import { TerminalContextMenu } from "@/components/terminal/TerminalContextMenu";
import { TerminalGestureLayer } from "@/components/terminal/TerminalGestureLayer";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsComposeSheet } from "@/hooks/use-compose-sheet";
import { useKeybindings } from "@/hooks/useKeybindings";
import { COMPOSE_SHEET_DISMISS_DRAG_PX } from "@/lib/terminal/config";
import { copyTerminalSelection, pasteToTerminal } from "@/lib/terminal/actions";

const InteractiveTerminal = dynamic(
  () => import("@/components/workspaces/InteractiveTerminal").then((m) => m.InteractiveTerminal),
  { ssr: false },
);

function TerminalInner({ agentId, workspaceId }: { agentId: string; workspaceId: string }) {
  const searchParams = useSearchParams();
  const session = searchParams.get("session");
  const { setActiveTerminal, activeTerminal, activeSend, register, unregister } = useKeybindings();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuSelection, setMenuSelection] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const composeSheetDragStartYRef = useRef<number | null>(null);
  const isComposeSheet = useIsComposeSheet();

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
    if (!session) {
      console.log(
        `[workspaces] No session param for workspace ${workspaceId}, dispatching sidebar refresh`,
      );
      window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));
    }
  }, [session, workspaceId]);

  if (!session) {
    return (
      <div className="-m-6 -mt-14 flex h-[100vh] w-[calc(100%+3rem)] items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Waiting for session…</span>
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
        className="relative -m-6 -mt-14 h-[100vh] w-[calc(100%+3rem)]"
        onKeyDown={(e) => e.stopPropagation()}
      >
        {terminalPane}
        <button
          type="button"
          aria-label="Open compose panel"
          className="absolute top-4 right-4 z-40 flex h-11 min-w-11 items-center justify-center rounded-full border border-border bg-background/90 px-4 text-sm font-medium shadow-lg backdrop-blur hover:bg-accent hover:text-accent-foreground"
          onClick={() => setComposeOpen(true)}
        >
          Compose
        </button>
        <Sheet open={composeOpen} onOpenChange={setComposeOpen}>
          <SheetContent side="bottom" className="h-[100dvh] p-0">
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
            <ComposePanel hideHeader onClose={() => setComposeOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div
      className="-m-6 -mt-14 h-[100vh] w-[calc(100%+3rem)]"
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
        <div className="-m-6 -mt-14 flex h-[100vh] w-[calc(100%+3rem)] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <TerminalInner agentId={agentId} workspaceId={workspaceId} />
    </Suspense>
  );
}
