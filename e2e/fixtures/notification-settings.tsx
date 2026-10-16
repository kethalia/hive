import { createRoot } from "react-dom/client";
import { NotificationListener } from "../../src/components/notification-listener";
import { NotificationSettings } from "../../src/components/notification-settings";
import { PushPermissionPrompt } from "../../src/components/push-permission-prompt";
import { SidebarProvider } from "../../src/components/ui/sidebar";
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
  <SidebarProvider>
    <NotificationListener />
    <PushPermissionPrompt />
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
