import { createRoot } from "react-dom/client";
import { WorkspaceToolPanel } from "../../src/components/workspaces/WorkspaceToolPanel";
import type { CoderWorkspace } from "../../src/lib/coder/types";

const workspace = {
  id: "aaaaaaaa-1111-2222-3333-444444444444",
  name: "Isolation validation",
  owner_name: "fixture-user",
  template_name: "browser-testing",
  latest_build: { id: "fixture-build", status: "running" },
} as CoderWorkspace;

const root = document.getElementById("app");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <main className="h-dvh p-4">
    <h1 className="mb-3 text-lg font-semibold">Workspace app isolation</h1>
    <div id="hive-private-marker" className="sr-only">
      Hive private marker
    </div>
    <div style={{ height: "calc(100vh - 80px)" }}>
      <WorkspaceToolPanel
        workspace={workspace}
        agentId="fixture-agent"
        agentName="main"
        coderUrl="https://coder.example.test"
      />
    </div>
  </main>,
);
