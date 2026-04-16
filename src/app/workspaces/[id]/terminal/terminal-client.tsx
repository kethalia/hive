"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

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

  if (!session) {
    return (
      <div className="flex items-center justify-center" style={{ height: "calc(100vh - 3.5rem - 3rem)" }}>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Waiting for session…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="-m-6" style={{ height: "calc(100vh - 3.5rem)" }}>
      <InteractiveTerminal
        key={session}
        agentId={agentId}
        workspaceId={workspaceId}
        sessionName={session}
        className="h-full rounded-none border-0"
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
        <div className="flex items-center justify-center" style={{ height: "calc(100vh - 3.5rem - 3rem)" }}>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <TerminalInner agentId={agentId} workspaceId={workspaceId} />
    </Suspense>
  );
}
