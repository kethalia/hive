"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { playNotificationSound, unlockNotificationAudio } from "@/lib/push/sound";
import { notificationKindSchema } from "@/lib/push/types";
import { TERMINAL_NOTIFICATION_FOCUS_EVENT } from "@/lib/terminal/events";

export function NotificationListener() {
  const router = useRouter();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const unlock = () => {
      void unlockNotificationAudio().catch(() => {});
    };
    const navigate = (value: string) => {
      let url: URL;
      try {
        url = new URL(value, window.location.origin);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      const workspace = /^\/workspaces\/([^/]+)\/terminal(?:\/workspace)?$/.exec(url.pathname);
      const sessionName = url.searchParams.get("session");
      if (workspace && sessionName && /^[a-zA-Z0-9._-]{1,200}$/.test(sessionName)) {
        let workspaceId: string;
        try {
          workspaceId = decodeURIComponent(workspace[1]);
        } catch {
          return;
        }
        const event = new CustomEvent(TERMINAL_NOTIFICATION_FOCUS_EVENT, {
          cancelable: true,
          detail: { workspaceId, sessionName },
        });
        if (!window.dispatchEvent(event)) return;
      }
      router.push(url.pathname + url.search);
    };
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "hive:navigate" && typeof data.url === "string") {
        let url: URL;
        try {
          url = new URL(data.url, window.location.origin);
        } catch {
          return;
        }
        if (url.origin === window.location.origin && url.pathname.startsWith("/workspaces/")) {
          navigate(url.href);
          event.ports[0]?.postMessage({ type: "hive:navigated" });
        }
        return;
      }
      const kind = notificationKindSchema.safeParse(data?.payload?.kind);
      if (
        data?.type !== "hive:notification" ||
        !kind.success ||
        document.visibilityState !== "visible"
      )
        return;
      const payload = data.payload;
      toast(payload.title, {
        description: payload.body,
        action: {
          label: "Open",
          onClick: () => {
            navigate(payload.url);
          },
        },
      });
      void playNotificationSound(kind.data).catch(() => {});
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    navigator.serviceWorker.addEventListener("message", receive);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      navigator.serviceWorker.removeEventListener("message", receive);
    };
  }, [router]);
  return null;
}
