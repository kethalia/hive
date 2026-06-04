import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { PushPermissionPrompt } from "@/components/push-permission-prompt";
import { SidebarEdgeHandle } from "@/components/sidebar-edge-handle";
import { HelpOverlay } from "@/components/terminal/HelpOverlay";
import KeybindingProvider from "@/components/terminal/KeybindingProvider";
import { TokenExpiryBanner } from "@/components/token-expiry-banner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
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
          <main className="flex-1 px-6 pt-[calc(var(--safe-area-inset-top)+0.75rem)] pb-0 md:pb-[calc(var(--safe-area-inset-bottom)+1.5rem)]">
            <div className="flex min-h-0 items-start gap-2">
              <SidebarTrigger className="mt-1 shrink-0" />
              <div className="min-w-0 flex-1">
                {bannerStatus?.data && <TokenExpiryBanner status={bannerStatus.data} />}
                <PushPermissionPrompt />
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
