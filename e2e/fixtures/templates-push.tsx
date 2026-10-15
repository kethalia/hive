import { createRoot } from "react-dom/client";
import { TemplatesClient } from "../../src/components/templates/TemplatesClient";
import { SidebarProvider } from "../../src/components/ui/sidebar";

const statuses = ["ai-dev-k8s", "browser-testing", "game-dev", "electronics", "infrastructure"].map(
  (name) => ({
    name,
    stale: true,
    lastPushed: "2026-10-12T00:00:00Z",
    activeVersionId: "fixture-version",
    localHash: "fixture-local",
    remoteHash: "fixture-remote",
  }),
);

const root = document.getElementById("app");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <SidebarProvider>
    <main className="flex h-[100dvh] min-h-0 w-full flex-1 overflow-hidden">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <TemplatesClient initialStatuses={statuses} />
      </div>
    </main>
  </SidebarProvider>,
);
