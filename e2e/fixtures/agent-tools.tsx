import { createRoot } from "react-dom/client";
import { AgentToolsDialog } from "../../src/components/workspaces/AgentToolsDialog";

const root = document.getElementById("app");
if (!root) throw new Error("Missing preview root");
createRoot(root).render(
  <AgentToolsDialog
    workspaceId="11111111-1111-4111-8111-111111111111"
    open
    onOpenChange={() => {}}
    onOpenSession={(sessionName) => {
      document.body.dataset.openedSession = sessionName;
    }}
  />,
);
