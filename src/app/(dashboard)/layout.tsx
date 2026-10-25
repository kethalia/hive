import "@/styles/xterm.css";
import { createHash } from "node:crypto";
import { AppViewportSize } from "@/components/app-viewport-size";
import { DashboardKeyboardController } from "@/components/dashboard-keyboard-controller";
import { DiscoveryProvider } from "@/components/discovery/DiscoveryProvider";
import { NotificationListener } from "@/components/notification-listener";
import { PushPermissionPrompt } from "@/components/push-permission-prompt";
import { RuntimeConfigProvider } from "@/components/runtime-config-provider";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { HelpOverlay } from "@/components/terminal/HelpOverlay";
import KeybindingProvider from "@/components/terminal/KeybindingProvider";
import { PersistentTerminalProvider } from "@/components/terminal/PersistentTerminalProvider";
import { TokenExpiryBanner } from "@/components/token-expiry-banner";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getTokenStatusAction } from "@/lib/auth/actions";
import { getRequestSession } from "@/lib/auth/session";
import {
  getServerRuntimeConfig,
  RUNTIME_CONFIG_ELEMENT_ID,
  serializeRuntimeConfig,
} from "@/lib/runtime-config";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [bannerStatus, session] = await Promise.all([getTokenStatusAction(), getRequestSession()]);
  const cacheScope = createHash("sha256")
    .update(session?.session.sessionId ?? "anonymous")
    .digest("hex");
  const runtimeConfig = getServerRuntimeConfig();

  return (
    <DiscoveryProvider key={cacheScope}>
      <RuntimeConfigProvider config={runtimeConfig}>
        <script id={RUNTIME_CONFIG_ELEMENT_ID} type="application/json">
          {serializeRuntimeConfig(runtimeConfig)}
        </script>
        <ServiceWorkerRegister />
        <NotificationListener />
        <AppViewportSize />
        <TooltipProvider>
          <KeybindingProvider>
            <PersistentTerminalProvider>
              <div className="h-[var(--app-viewport-height)] min-h-0 overflow-hidden">
                <main
                  id="main-content"
                  className="crt-grid crt-scanlines flex h-full min-h-0 flex-1 overflow-hidden"
                  data-dashboard-main=""
                >
                  <div
                    className="flex h-full min-h-0 w-full flex-1 items-stretch gap-0"
                    data-dashboard-content-row=""
                  >
                    <div
                      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                      data-dashboard-content=""
                    >
                      {bannerStatus?.data && <TokenExpiryBanner status={bannerStatus.data} />}
                      <PushPermissionPrompt />
                      {children}
                    </div>
                  </div>
                </main>
              </div>
              <DashboardKeyboardController />
              <HelpOverlay />
            </PersistentTerminalProvider>
          </KeybindingProvider>
        </TooltipProvider>
        <Toaster />
      </RuntimeConfigProvider>
    </DiscoveryProvider>
  );
}
