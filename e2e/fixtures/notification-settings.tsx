import { createRoot } from "react-dom/client";
import { NotificationListener } from "../../src/components/notification-listener";
import { NotificationSettings } from "../../src/components/notification-settings";
import { SidebarProvider } from "../../src/components/ui/sidebar";
import { Toaster } from "../../src/components/ui/sonner";

const subscription = {
  endpoint: "https://fcm.googleapis.com/send/browser-fixture",
  toJSON: () => ({ keys: { p256dh: "fixture-public-key", auth: "fixture-auth" } }),
  unsubscribe: async () => true,
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
  <SidebarProvider>
    <NotificationListener />
    <NotificationSettings
      connectedWorkspaceIds={[]}
      workspaceError={false}
      workspaces={[
        { id: "11111111-1111-4111-8111-111111111111", name: "ai-dev-01", running: true },
        { id: "22222222-2222-4222-8222-222222222222", name: "browser-testing", running: false },
      ]}
    />
    <Toaster />
  </SidebarProvider>,
);
