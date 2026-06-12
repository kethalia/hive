import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DashboardKeyboardController } from "@/components/dashboard-keyboard-controller";
import { DashboardSidebarTrigger } from "@/components/dashboard-sidebar-trigger";
import { PushPermissionPrompt } from "@/components/push-permission-prompt";
import { SidebarEdgeHandle } from "@/components/sidebar-edge-handle";
import { HelpOverlay } from "@/components/terminal/HelpOverlay";
import KeybindingProvider from "@/components/terminal/KeybindingProvider";
import { TokenExpiryBanner } from "@/components/token-expiry-banner";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getTokenStatusAction } from "@/lib/auth/actions";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const bannerStatus = await getTokenStatusAction();

  return (
    <SidebarProvider>
      <KeybindingProvider>
        <Suspense fallback={null}>
          <AppSidebar />
        </Suspense>
        <SidebarEdgeHandle />
        <SidebarInset className="h-[var(--app-viewport-height)] min-h-0 overflow-hidden">
          <main className="flex h-full min-h-0 flex-1 overflow-hidden" data-dashboard-main="">
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
  );
}
