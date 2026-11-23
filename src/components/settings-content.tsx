"use client";
import { Bell, Download, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppUpdateSettings } from "@/components/app-update-settings";
import {
  NotificationSettings,
  type NotificationSettingsProps,
} from "@/components/notification-settings";
import { Button, buttonVariants } from "@/components/ui/button";
import { PanelTabs, type PanelTabsNavigation } from "@/components/ui/panel-tabs";

const sections = [
  { id: "account", label: "Account", icon: <UserRound /> },
  { id: "updates", label: "App updates", icon: <Download /> },
  { id: "notifications", label: "Notifications", icon: <Bell /> },
] as const;

export function SettingsContent({
  email,
  coderUrl,
  coderOAuthEnabled = false,
  navigation,
  ...props
}: Omit<NotificationSettingsProps, "embedded"> & {
  email?: string;
  coderUrl?: string;
  coderOAuthEnabled?: boolean;
  navigation?: PanelTabsNavigation;
}) {
  const router = useRouter();
  const [section, setSection] = useState<(typeof sections)[number]["id"]>("account");
  useEffect(() => {
    const selectNotifications = () => {
      if (window.location.hash === "#notifications") setSection("notifications");
    };
    selectNotifications();
    window.addEventListener("hashchange", selectNotifications);
    return () => window.removeEventListener("hashchange", selectNotifications);
  }, []);
  const [signingOut, setSigningOut] = useState(false);
  const [accountError, setAccountError] = useState("");
  async function signOut(disconnect = false) {
    setSigningOut(true);
    setAccountError("");
    try {
      const response = await fetch(disconnect ? "/api/auth/coder/disconnect" : "/api/auth/logout", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Could not sign out. Try again.");
      }
      window.dispatchEvent(new Event("hive:discovery-clear"));
      router.push("/login");
      router.refresh();
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Could not sign out.");
      setSigningOut(false);
    }
  }
  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
      <PanelTabs
        label="Settings"
        items={sections}
        value={section}
        onChange={setSection}
        navigation={navigation}
      >
        <section className="space-y-3" aria-label="Account" hidden={section !== "account"}>
          <h2 className="text-base font-medium">Account</h2>
          {email ? <p className="break-all text-sm">{email}</p> : null}
          <div className="flex flex-wrap gap-2">
            {coderUrl ? (
              <a
                className={buttonVariants({
                  variant: "outline",
                  className: "h-auto min-h-10 whitespace-normal py-2",
                })}
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
            {coderOAuthEnabled && (
              <Button variant="outline" disabled={signingOut} onClick={() => void signOut(true)}>
                Disconnect Coder
              </Button>
            )}
          </div>
          {coderOAuthEnabled && (
            <p className="text-sm text-muted-foreground">
              Disconnecting revokes Hive’s Coder connection and ends this account’s Hive sessions.
            </p>
          )}
          {accountError ? <p role="alert">{accountError}</p> : null}
        </section>
        <section
          aria-labelledby="app-updates-heading"
          className="space-y-4"
          hidden={section !== "updates"}
        >
          <h2 id="app-updates-heading" className="text-base font-medium">
            App updates
          </h2>
          <AppUpdateSettings active={section === "updates"} />
        </section>
        <section
          id="notifications"
          aria-labelledby="notifications-heading"
          className="space-y-6"
          hidden={section !== "notifications"}
        >
          <div>
            <h2 id="notifications-heading" className="text-base font-medium">
              Notifications
            </h2>
            <p className="text-sm text-muted-foreground">Keep your agents within earshot.</p>
          </div>
          <NotificationSettings {...props} embedded />
        </section>
      </PanelTabs>
    </div>
  );
}
