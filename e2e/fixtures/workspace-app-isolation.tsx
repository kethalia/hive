import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GeneralWorkspacePane } from "../../src/components/workspaces/GeneralWorkspacePane";
import type { CoderWorkspace } from "../../src/lib/coder/types";

const workspace = {
  id: "aaaaaaaa-1111-2222-3333-444444444444",
  name: "Isolation validation",
  owner_name: "fixture-user",
  template_name: "browser-testing",
  latest_build: { id: "fixture-build", status: "running" },
} as CoderWorkspace;
function Fixture() {
  const [tool, setTool] = useState<"files" | "desktop" | "terminal">("terminal");
  const [visited, setVisited] = useState<Array<"files" | "desktop">>([]);
  function open(value: "files" | "desktop") {
    setTool(value);
    setVisited((items) => (items.includes(value) ? items : [...items, value]));
  }
  return (
    <main className="h-dvh p-4">
      <h1>Workspace app isolation</h1>
      <div id="hive-private-marker" className="sr-only">
        Hive private marker
      </div>
      <button type="button" onClick={() => setTool("terminal")}>
        Terminal
      </button>
      <button type="button" onClick={() => open("files")}>
        Files
      </button>
      <button type="button" onClick={() => open("desktop")}>
        Desktop
      </button>
      <div style={{ height: "calc(100vh - 80px)" }}>
        {visited.map((item) => (
          <div key={item} style={{ height: "100%", display: tool === item ? "block" : "none" }}>
            <GeneralWorkspacePane
              pane={{
                id: item,
                kind: "app",
                workspaceId: workspace.id,
                tool: item,
                label: item === "files" ? "Filebrowser" : "KasmVNC",
              }}
              workspace={workspace}
              boardKey="general"
              active={tool === item}
              visible={tool === item}
              mobile={false}
              layoutSignal="fixture"
              onActivate={() => {}}
              onClose={() => {}}
              onOpenTool={() => {}}
              onOpenFile={() => {}}
              onReady={() => {}}
              onDestroy={() => {}}
              onStart={() => {}}
            />
          </div>
        ))}
      </div>
    </main>
  );
}
const root = document.getElementById("app");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient()}>
    <Fixture />
  </QueryClientProvider>,
);
