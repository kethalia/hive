import { createRoot } from "react-dom/client";
import { AgentToolsPanel } from "../../src/components/workspaces/AgentToolsPanel";

const root = document.getElementById("app");
if (!root) throw new Error("Missing preview root");
createRoot(root).render(
  <AgentToolsPanel
    workspaceId="11111111-1111-4111-8111-111111111111"
    open
    onOpenSession={(sessionName) => {
      document.body.dataset.openedSession = sessionName;
    }}
  />,
);
