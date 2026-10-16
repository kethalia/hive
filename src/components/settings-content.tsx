import { AppUpdateSettings } from "@/components/app-update-settings";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { DashboardPageShell } from "@/components/dashboard-page-shell";
import {
  NotificationSettings,
  type NotificationSettingsProps,
} from "@/components/notification-settings";

export function SettingsContent(props: Omit<NotificationSettingsProps, "embedded">) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
      <DashboardPageShell className="min-w-0">
        <DashboardPageHeader title="Settings" description="Manage your app and notifications" />
        <div className="mx-auto w-full min-w-0 max-w-6xl divide-y divide-border pb-8">
          <section aria-labelledby="app-updates-heading" className="space-y-4 pb-8">
            <header className="space-y-1">
              <h2 id="app-updates-heading" className="text-base font-medium">
                App updates
              </h2>
              <p className="text-sm text-muted-foreground">
                Check versions and update Hive on this device.
              </p>
            </header>
            <AppUpdateSettings />
          </section>
          <section
            id="notifications"
            aria-labelledby="notifications-heading"
            className="space-y-6 pt-8 scroll-mt-4"
          >
            <div>
              <h2 id="notifications-heading" className="text-base font-medium">
                Notifications
              </h2>
              <p className="text-sm text-muted-foreground">Keep your agents within earshot.</p>
            </div>
            <NotificationSettings {...props} embedded />
          </section>
        </div>
      </DashboardPageShell>
    </div>
  );
}
