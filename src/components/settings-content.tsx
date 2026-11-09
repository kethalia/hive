"use client";
import type { CoderDisconnectResult } from "@hive/auth";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AppUpdateSettings } from "@/components/app-update-settings";
import {
  CoderDisconnectNotice,
  type CoderDisconnectOutcome,
} from "@/components/coder-disconnect-notice";
import {
  NotificationSettings,
  type NotificationSettingsProps,
} from "@/components/notification-settings";
import { Button } from "@/components/ui/button";
import { disconnectCoderConnection } from "@/lib/settings/window-client";
import type { CoderConnection } from "@/lib/settings/window-contracts";

export function SettingsContent({
  email,
  coderUrl,
  coderConnection,
  onCoderDisconnect,
  ...props
}: Omit<NotificationSettingsProps, "embedded"> & {
  email?: string;
  coderUrl?: string;
  coderConnection?: CoderConnection;
  onCoderDisconnect?: (outcome: CoderDisconnectOutcome) => void;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectResult, setDisconnectResult] = useState<CoderDisconnectResult | null>(null);
  const [disconnectError, setDisconnectError] = useState<
    "connection_changed" | "disconnect_unknown" | null
  >(null);
  const disconnectSubmitted = useRef(false);
  async function disconnect() {
    if (disconnectSubmitted.current || coderConnection?.source !== "oauth") return;
    disconnectSubmitted.current = true;
    setDisconnecting(true);
    setConfirmDisconnect(false);
    try {
      const result = await disconnectCoderConnection({
        credentialId: coderConnection.credentialId,
        version: coderConnection.version,
      });
      setDisconnectResult(result);
      onCoderDisconnect?.({ result });
      window.dispatchEvent(new Event("hive:discovery-clear"));
    } catch (error) {
      const outcome =
        error instanceof Error && error.message === "connection_changed"
          ? "connection_changed"
          : "disconnect_unknown";
      setDisconnectError(outcome);
      onCoderDisconnect?.({ error: outcome });
      window.dispatchEvent(new Event("hive:discovery-clear"));
    } finally {
      setDisconnecting(false);
    }
  }
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
              <Button
                variant="outline"
                disabled={signingOut || disconnecting}
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
              {coderConnection?.source === "oauth" &&
              coderConnection.status === "connected" &&
              !disconnectResult &&
              !disconnectError &&
              !confirmDisconnect ? (
                <Button
                  variant="outline"
                  disabled={signingOut || disconnecting}
                  onClick={() => setConfirmDisconnect(true)}
                >
                  {disconnecting ? "Disconnecting…" : "Disconnect Coder"}
                </Button>
              ) : null}
            </div>
            {confirmDisconnect ? (
              <fieldset
                className="space-y-2 rounded-md border p-3"
                aria-label="Confirm Coder disconnect"
              >
                <p className="text-sm">
                  Disconnect this Coder connection and end its Hive sessions? Hive will need a
                  connection to access Coder again.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={disconnecting} onClick={() => void disconnect()}>
                    Confirm disconnect
                  </Button>
                  <Button variant="outline" onClick={() => setConfirmDisconnect(false)}>
                    Cancel
                  </Button>
                </div>
              </fieldset>
            ) : null}
            {disconnecting ? <p role="status">Disconnecting this Coder connection…</p> : null}
            {disconnectResult ? (
              <CoderDisconnectNotice outcome={{ result: disconnectResult }} />
            ) : disconnectError ? (
              <CoderDisconnectNotice outcome={{ error: disconnectError }} />
            ) : null}
            {!disconnectResult &&
            !disconnectError &&
            coderConnection?.source === "oauth" &&
            coderConnection.status === "reconnect" ? (
              <div className="flex flex-wrap gap-3 text-sm">
                <a className="underline" href="/workspaces">
                  Refresh Hive
                </a>
                <a className="underline" href="/api/auth/coder/start">
                  Continue with Coder
                </a>
              </div>
            ) : null}
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
