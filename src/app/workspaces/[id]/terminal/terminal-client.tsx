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
}

export function TerminalClient({ agentId, coderUrl }: TerminalClientProps) {
  return (
    <div className="flex h-screen flex-col bg-background p-4">
      <InteractiveTerminal
        agentId={agentId}
        sessionName="hive-main"
        coderUrl={coderUrl}
        className="flex-1"
      />
    </div>
  );
}
