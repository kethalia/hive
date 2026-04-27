"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { TerminalContextMenu } from "@/components/terminal/TerminalContextMenu";
import { useKeybindings } from "@/hooks/useKeybindings";
import { copyTerminalSelection, pasteToTerminal } from "@/lib/terminal/actions";

const InteractiveTerminal = dynamic(
  () =>
    import("@/components/workspaces/InteractiveTerminal").then(
      (m) => m.InteractiveTerminal,
    ),
  { ssr: false },
);

function TerminalInner({ agentId, workspaceId }: { agentId: string; workspaceId: string }) {
  const searchParams = useSearchParams();
  const session = searchParams.get("session");
  const { setActiveTerminal, activeTerminal, activeSend } = useKeybindings();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuSelection, setMenuSelection] = useState(false);

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
    if (!session) {
      console.log(`[workspaces] No session param for workspace ${workspaceId}, dispatching sidebar refresh`);
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

  return (
    <div
      className="-m-6 -mt-14 h-[100vh] w-[calc(100%+3rem)]"
      onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuSelection(!!activeTerminal?.getSelection());
        setMenuPosition({ x: e.clientX, y: e.clientY });
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
