"use client";

import { Bell, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getVapidPublicKeyAction } from "@/lib/push/actions";
import { subscribePushAction } from "@/lib/push/subscribe";

const DISMISS_KEY = "push-prompt-dismissed";
const STILL_BLOCKED_MESSAGE =
  "Notifications are still blocked. Open your browser's site settings, allow notifications for this site, then retry.";
const RETRY_SUBSCRIBE_FAILURE_MESSAGE =
  "We could not restore notifications. Please try again after checking this site's notification settings.";

function base64urlToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + padding;
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}

async function subscribeToNotifications() {
  const result = await getVapidPublicKeyAction();
  if (!result?.data?.publicKey) {
    throw new Error("Failed to get VAPID public key");
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64urlToUint8Array(result.data.publicKey),
  });

  const json = subscription.toJSON();
  const subscribeResult = await subscribePushAction({
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
  });
  if (!subscribeResult?.data?.success) {
    throw new Error("Failed to save push subscription");
  }
}

export function PushPermissionPrompt() {
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;

    setPermission(Notification.permission);
    setDismissed(localStorage.getItem(DISMISS_KEY) === "true");

    if (Notification.permission === "granted") {
      navigator.serviceWorker.ready
        .then((reg) => reg.pushManager.getSubscription())
        .then((sub) => {
          if (!sub) {
            subscribeToNotifications().catch((err) => {
              console.error("[push] Auto-subscribe failed:", err);
            });
          }
        })
        .catch(() => {});
    }
  }, []);

  const handleEnable = useCallback(async () => {
    setSubscribing(true);
    setError(null);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === "granted") {
        await subscribeToNotifications();
      }
    } catch (err) {
      console.error("[push] Subscribe failed:", err);
      setError("Failed to enable notifications. Please try again.");
    } finally {
      setSubscribing(false);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, "true");
    setDismissed(true);
  }, []);

  const handleRetry = useCallback(async () => {
    setSubscribing(true);
    setError(null);
    try {
      const currentPermission = Notification.permission;

      if (currentPermission === "denied") {
        setPermission("denied");
        setError(STILL_BLOCKED_MESSAGE);
        return;
      }

      if (currentPermission === "default") {
        setPermission("default");
        return;
      }

      await subscribeToNotifications();
      setPermission("granted");
    } catch (err) {
      console.error("[push] Retry subscribe failed:", err);
      setPermission("denied");
      setError(RETRY_SUBSCRIBE_FAILURE_MESSAGE);
    } finally {
      setSubscribing(false);
    }
  }, []);

  if (!permission || permission === "granted") return null;
  if (dismissed) return null;

  if (permission === "denied") {
    return (
      <div className="fixed right-4 bottom-4 z-50 w-[calc(100vw-2rem)] max-w-96 pb-safe sm:w-96">
        <Alert>
          <Bell className="size-4" />
          <AlertTitle>Notifications blocked</AlertTitle>
          <AlertDescription>
            Push notifications are blocked by your browser. To enable them, open your browser&apos;s
            site settings and allow notifications for this site.
            {error && <p className="text-destructive mt-1">{error}</p>}
          </AlertDescription>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" size="xs" onClick={handleDismiss} disabled={subscribing}>
              Dismiss
            </Button>
            <Button size="xs" onClick={handleRetry} disabled={subscribing}>
              {subscribing ? "Retrying…" : "Retry"}
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 pb-safe w-96">
      <Alert className="relative">
        <div className="flex items-center gap-2">
          <Bell className="size-4 shrink-0" />
          <AlertTitle>Stay notified</AlertTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            onClick={handleDismiss}
            aria-label="Dismiss notification prompt"
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <AlertDescription className="mt-1 pr-6">
          Get notified when your Coder token is about to expire so you never lose access.
          {error && <p className="text-destructive mt-1">{error}</p>}
        </AlertDescription>
        <div className="mt-2 flex justify-end">
          <Button size="xs" onClick={handleEnable} disabled={subscribing}>
            {subscribing ? "Enabling…" : "Enable notifications"}
          </Button>
        </div>
      </Alert>
    </div>
  );
}
