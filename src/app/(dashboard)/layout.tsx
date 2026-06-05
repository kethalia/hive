import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DashboardSidebarTrigger } from "@/components/dashboard-sidebar-trigger";
import { PushPermissionPrompt } from "@/components/push-permission-prompt";
import { PwaInstallPrompt } from "@/components/pwa-install-prompt";
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
        <SidebarInset>
          <main
            className="flex min-h-0 flex-1 overflow-hidden px-6 pt-[calc(var(--safe-area-inset-top)+0.75rem)] pb-0 md:pb-[calc(var(--safe-area-inset-bottom)+1.5rem)]"
            data-dashboard-main=""
          >
            <div
              className="flex min-h-0 w-full flex-1 items-start gap-2"
              data-dashboard-content-row=""
            >
              <DashboardSidebarTrigger />
              <div className="min-w-0 flex-1" data-dashboard-content="">
                {bannerStatus?.data && <TokenExpiryBanner status={bannerStatus.data} />}
                <PushPermissionPrompt />
                <PwaInstallPrompt />
                {children}
              </div>
            </div>
          </main>
        </SidebarInset>
        <HelpOverlay />
      </KeybindingProvider>
    </SidebarProvider>
  );
}
