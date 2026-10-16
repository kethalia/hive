import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { DashboardSidebarTrigger } from "../../src/components/dashboard-sidebar-trigger";
import { NotificationListener } from "../../src/components/notification-listener";
import { NotificationSettings } from "../../src/components/notification-settings";
import { PushPermissionPrompt } from "../../src/components/push-permission-prompt";
import { Sidebar, SidebarInset, SidebarProvider } from "../../src/components/ui/sidebar";
import { Toaster } from "../../src/components/ui/sonner";

const subscription = {
  endpoint: "https://fcm.googleapis.com/send/browser-fixture",
  toJSON: () => ({ keys: { p256dh: "fixture-public-key", auth: "fixture-auth" } }),
  unsubscribe: async () => true,
};
// The browser context grants real notification access. Start the UI at default
// to exercise setup from both controls without automating a native consent dialog.
let permission: NotificationPermission = "default";
Object.defineProperty(Notification, "permission", { get: () => permission });
Notification.requestPermission = async () => {
  permission = "granted";
  return permission;
};
let enabled = false;
PushManager.prototype.getSubscription = async () =>
  enabled ? (subscription as unknown as PushSubscription) : null;
PushManager.prototype.subscribe = async () => {
  enabled = true;
  return subscription as unknown as PushSubscription;
};
void navigator.serviceWorker.register("/sw.js");
const root = document.getElementById("app");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <SidebarProvider
    className="h-dvh overflow-hidden"
    style={{ "--app-viewport-height": "100dvh" } as CSSProperties}
  >
    <Sidebar collapsible="none" className="hidden w-64 shrink-0 md:flex">
      <p className="p-4">Hive navigation</p>
    </Sidebar>
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <main className="crt-grid flex h-full min-h-0 overflow-hidden">
        <DashboardSidebarTrigger />
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <NotificationListener />
          <PushPermissionPrompt />
          <NotificationSettings
            connectedWorkspaceIds={["11111111-1111-4111-8111-111111111111"]}
            pendingWorkspaceIds={["11111111-1111-4111-8111-111111111111"]}
            workspaceError={false}
            workspaces={[
              { id: "11111111-1111-4111-8111-111111111111", name: "ai-dev-01", running: true },
              {
                id: "22222222-2222-4222-8222-222222222222",
                name: "browser-testing",
                running: false,
              },
            ]}
          />
        </div>
      </main>
    </SidebarInset>
    <Toaster />
  </SidebarProvider>,
);
