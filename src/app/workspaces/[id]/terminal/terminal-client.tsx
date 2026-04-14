"use client";

import dynamic from "next/dynamic";

const InteractiveTerminal = dynamic(
  () =>
    import("@/components/workspaces/InteractiveTerminal").then(
      (m) => m.InteractiveTerminal,
    ),
  { ssr: false },
);

interface TerminalClientProps {
  agentId: string;
  coderUrl: string;
  sessionName: string;
}

export function TerminalClient({ agentId, coderUrl, sessionName }: TerminalClientProps) {
  return (
    <div className="flex h-screen flex-col bg-background p-4">
      <InteractiveTerminal
        agentId={agentId}
        sessionName={sessionName}
        coderUrl={coderUrl}
        className="flex-1"
      />
    </div>
  );
}
