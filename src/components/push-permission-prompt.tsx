"use client";

import { useEffect, useState, useCallback } from "react";
import { Bell, X } from "lucide-react";
import { Alert, AlertTitle, AlertDescription, AlertAction } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getVapidPublicKeyAction } from "@/lib/push/actions";
import { subscribePushAction } from "@/lib/push/subscribe";

const DISMISS_KEY = "push-prompt-dismissed";

function base64urlToUint8Array(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + padding;
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
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
  await subscribePushAction({
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
  });
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

  if (!permission || permission === "granted") return null;

  if (permission === "denied") {
    return (
      <Alert className="mb-4">
        <Bell className="size-4" />
        <AlertTitle>Notifications blocked</AlertTitle>
        <AlertDescription>
          Push notifications are blocked by your browser. To enable them, open
          your browser&apos;s site settings and allow notifications for this
          site.
        </AlertDescription>
      </Alert>
    );
  }

  if (dismissed) return null;

  return (
    <Alert className="mb-4">
      <Bell className="size-4" />
      <AlertTitle>Stay notified</AlertTitle>
      <AlertDescription>
        Get notified when your Coder token is about to expire so you never lose
        access.
        {error && <p className="text-destructive mt-1">{error}</p>}
      </AlertDescription>
      <AlertAction className="flex gap-2">
        <Button
          variant="ghost"
          size="xs"
          onClick={handleDismiss}
          aria-label="Dismiss notification prompt"
        >
          <X className="size-3.5" />
        </Button>
        <Button size="xs" onClick={handleEnable} disabled={subscribing}>
          {subscribing ? "Enabling…" : "Enable notifications"}
        </Button>
      </AlertAction>
    </Alert>
  );
}
