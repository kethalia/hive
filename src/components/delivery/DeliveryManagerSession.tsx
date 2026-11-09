"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { ConversationView } from "@/components/projects/ConversationView";
import { Button } from "@/components/ui/button";
import { useProjectConversation } from "@/hooks/useProjectConversation";
import type { DeliveryTaskDetail } from "@/lib/delivery/read-contracts";

const ProjectTerminal = dynamic(
  () => import("@/components/projects/ProjectTerminal").then((m) => m.ProjectTerminal),
  { ssr: false },
);

/** Opening a task link subscribes to its existing manager. It does not prepare a
 * checkout, submit a prompt or redirect the link to a replacement thread. */
export function DeliveryManagerSession({
  manager,
}: {
  manager: NonNullable<DeliveryTaskDetail["manager"]>;
}) {
  const [mode, setMode] = useState<"conversation" | "terminal">("conversation");
  const [terminalOpened, setTerminalOpened] = useState(false);
  const { view, reconnect } = useProjectConversation(manager.projectId, true, manager);
  const openTerminal = () => {
    setTerminalOpened(true);
    setMode("terminal");
  };
  return (
    <section aria-label="Task manager" className="space-y-2 rounded-md border p-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          aria-pressed={mode === "conversation"}
          onClick={() => setMode("conversation")}
        >
          Conversation
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={mode === "terminal"}
          onClick={openTerminal}
        >
          Terminal
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Both views use this task’s manager session. If it is unavailable, reconnect after the
        workspace has recovered.
      </p>
      <div className="h-[28rem] min-w-0" hidden={mode !== "conversation"}>
        <ConversationView
          sessionKey={manager.conversationId}
          view={view}
          onReconnect={reconnect}
          onOpenTerminal={openTerminal}
        />
      </div>
      {terminalOpened && (
        <div className="h-[28rem] min-w-0" hidden={mode !== "terminal"}>
          <ProjectTerminal
            projectId={manager.projectId}
            expected={manager}
            visible={mode === "terminal"}
          />
        </div>
      )}
    </section>
  );
}
