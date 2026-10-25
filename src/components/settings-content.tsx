"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppUpdateSettings } from "@/components/app-update-settings";
import {
  NotificationSettings,
  type NotificationSettingsProps,
} from "@/components/notification-settings";
import { Button } from "@/components/ui/button";

export function SettingsContent({
  email,
  coderUrl,
  ...props
}: Omit<NotificationSettingsProps, "embedded"> & { email?: string; coderUrl?: string }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [accountError, setAccountError] = useState("");
  async function signOut() {
    setSigningOut(true);
    setAccountError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not sign out. Try again.");
      window.dispatchEvent(new Event("hive:discovery-clear"));
      router.push("/login");
      router.refresh();
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Could not sign out.");
      setSigningOut(false);
    }
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
      <div className="min-w-0 p-4">
        <div className="mx-auto w-full min-w-0 max-w-6xl divide-y divide-border pb-8">
          <section className="space-y-3 py-4" aria-label="Account">
            <h2 className="text-base font-medium">Account</h2>
            {email ? <p className="break-all text-sm">{email}</p> : null}
            <div className="flex flex-wrap gap-2">
              {coderUrl ? (
                <a
                  className="inline-flex items-center rounded-md border px-3 text-sm"
                  href={coderUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Coder ↗
                </a>
              ) : null}
              <Button variant="outline" disabled={signingOut} onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
            {accountError ? <p role="alert">{accountError}</p> : null}
          </section>
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
      </div>
    </div>
  );
}
