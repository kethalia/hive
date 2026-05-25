import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { PushPermissionPrompt } from "@/components/push-permission-prompt";
import { SidebarEdgeHandle } from "@/components/sidebar-edge-handle";
import { TokenExpiryBanner } from "@/components/token-expiry-banner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { getTokenStatusAction } from "@/lib/auth/actions";
import KeybindingProvider from "@/components/terminal/KeybindingProvider";
import { HapticFloatingActionButton } from "@/components/terminal/HapticFloatingActionButton";
import { HelpOverlay } from "@/components/terminal/HelpOverlay";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const bannerStatus = await getTokenStatusAction();

  return (
    <SidebarProvider>
      <KeybindingProvider>
        <Suspense fallback={null}>
          <AppSidebar />
        </Suspense>
        <SidebarTrigger className="fixed top-3 left-3 z-50 transition-opacity md:opacity-0 md:pointer-events-none md:peer-data-[state=collapsed]:opacity-100 md:peer-data-[state=collapsed]:pointer-events-auto" />
        <SidebarEdgeHandle />
        <SidebarInset>
          <main className="flex-1 p-6 pt-14">
            {bannerStatus?.data && <TokenExpiryBanner status={bannerStatus.data} />}
            <PushPermissionPrompt />
            {children}
          </main>
        </SidebarInset>
        <HapticFloatingActionButton />
        <HelpOverlay />
      </KeybindingProvider>
    </SidebarProvider>
  );
}
