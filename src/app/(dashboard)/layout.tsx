import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { AppViewportSize } from "@/components/app-viewport-size";
import { DashboardKeyboardController } from "@/components/dashboard-keyboard-controller";
import { DashboardSidebarTrigger } from "@/components/dashboard-sidebar-trigger";
import { PushPermissionPrompt } from "@/components/push-permission-prompt";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { SidebarEdgeHandle } from "@/components/sidebar-edge-handle";
import { HelpOverlay } from "@/components/terminal/HelpOverlay";
import KeybindingProvider from "@/components/terminal/KeybindingProvider";
import { TokenExpiryBanner } from "@/components/token-expiry-banner";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getTokenStatusAction } from "@/lib/auth/actions";
import { getServerRuntimeConfig, serializeRuntimeConfig } from "@/lib/runtime-config";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const bannerStatus = await getTokenStatusAction();
  const runtimeConfig = serializeRuntimeConfig(getServerRuntimeConfig());

  return (
    <>
      {/* Inline server values so terminal components cannot hydrate before config is available. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: serializeRuntimeConfig escapes script-breaking input. */}
      <script dangerouslySetInnerHTML={{ __html: runtimeConfig }} />
      <ServiceWorkerRegister />
      <AppViewportSize />
      <TooltipProvider>
        <SidebarProvider>
          <KeybindingProvider>
            <Suspense fallback={null}>
              <AppSidebar />
            </Suspense>
            <SidebarEdgeHandle />
            <SidebarInset className="h-[var(--app-viewport-height)] min-h-0 overflow-hidden">
              <main
                id="main-content"
                className="crt-grid crt-scanlines flex h-full min-h-0 flex-1 overflow-hidden"
                data-dashboard-main=""
              >
                <div
                  className="flex h-full min-h-0 w-full flex-1 items-stretch gap-0"
                  data-dashboard-content-row=""
                >
                  <DashboardSidebarTrigger />
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
            </SidebarInset>
            <DashboardKeyboardController />
            <HelpOverlay />
          </KeybindingProvider>
        </SidebarProvider>
      </TooltipProvider>
      <Toaster />
    </>
  );
}
