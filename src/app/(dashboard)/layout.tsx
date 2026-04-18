import { Suspense } from "react";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <Suspense fallback={null}>
        <AppSidebar />
      </Suspense>
      <SidebarTrigger className="fixed top-3 left-3 z-50 opacity-0 pointer-events-none transition-opacity peer-data-[state=collapsed]:opacity-100 peer-data-[state=collapsed]:pointer-events-auto" />
      <SidebarInset>
        <main className="flex-1 p-6 pt-14">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
