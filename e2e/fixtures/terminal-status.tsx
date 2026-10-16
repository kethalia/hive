import { createRoot } from "react-dom/client";
import { DashboardSidebarTrigger } from "../../src/components/dashboard-sidebar-trigger";
import { RuntimeConfigProvider } from "../../src/components/runtime-config-provider";
import { SidebarInset, SidebarProvider } from "../../src/components/ui/sidebar";
import { TerminalSessionStatusClient } from "../../src/components/workspaces/TerminalSessionStatusClient";

const root = document.getElementById("app");
if (!root) throw new Error("Missing fixture root");

createRoot(root).render(
  <RuntimeConfigProvider config={{ terminalWsUrl: "/" }}>
    <SidebarProvider>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        <main className="crt-grid crt-scanlines flex h-full min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0 w-full flex-1 items-stretch gap-0">
            <DashboardSidebarTrigger />
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {new URLSearchParams(location.search).has("banner") ? (
                <p className="shrink-0 p-4">Fixture notification banner</p>
              ) : null}
              <TerminalSessionStatusClient
                highlightedWorkspaceId={
                  new URLSearchParams(location.search).get("workspaceId") ?? undefined
                }
              />
            </div>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  </RuntimeConfigProvider>,
);
