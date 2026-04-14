"use client";

import { TerminalTabManager } from "@/components/workspaces/TerminalTabManager";
import type { TmuxSession } from "@/lib/workspaces/sessions";

interface TerminalClientProps {
  agentId: string;
  workspaceId: string;
  initialSessions: TmuxSession[];
  initialSessionName?: string;
}

export function TerminalClient({
  agentId,
  workspaceId,
  initialSessions,
  initialSessionName,
}: TerminalClientProps) {
  return (
    <TerminalTabManager
      agentId={agentId}
      workspaceId={workspaceId}
      initialSessions={initialSessions}
      initialSessionName={initialSessionName}
    />
  );
}
