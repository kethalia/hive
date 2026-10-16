"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { playNotificationSound, unlockNotificationAudio } from "@/lib/push/sound";
import { notificationKindSchema } from "@/lib/push/types";

export function NotificationListener() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const unlock = () => {
      void unlockNotificationAudio().catch(() => {});
    };
    const receive = (event: MessageEvent) => {
      const data = event.data;
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
            window.location.href = payload.url;
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
  }, []);
  return null;
}
