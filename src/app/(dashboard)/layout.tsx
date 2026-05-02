import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { PushPermissionPrompt } from "@/components/push-permission-prompt";
import { TokenExpiryBanner } from "@/components/token-expiry-banner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { getTokenStatusAction } from "@/lib/auth/actions";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const bannerStatus = await getTokenStatusAction();

  return (
    <SidebarProvider>
      <Suspense fallback={null}>
        <AppSidebar />
      </Suspense>
      <SidebarTrigger className="fixed top-3 left-3 z-50 opacity-0 pointer-events-none transition-opacity peer-data-[state=collapsed]:opacity-100 peer-data-[state=collapsed]:pointer-events-auto" />
      <SidebarInset>
        <main className="flex-1 p-6 pt-14">
          {bannerStatus?.data && <TokenExpiryBanner status={bannerStatus.data} />}
          <PushPermissionPrompt />
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
