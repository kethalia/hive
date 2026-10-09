"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ClipboardActionStatus } from "@/lib/terminal/actions";
import { clipboardFeedback } from "@/lib/terminal/clipboard-feedback";

export function useTerminalClipboardFeedback() {
  const [status, setStatus] = useState<ClipboardActionStatus | null>(null);
  const pendingToasts = useRef(new Map<ClipboardActionStatus["action"], string | number>());
  const mounted = useRef(true);

  const onStatus = useCallback((nextStatus: ClipboardActionStatus) => {
    if (!mounted.current) return;
    setStatus(nextStatus);
    const feedback = clipboardFeedback(nextStatus);
    const id = pendingToasts.current.get(nextStatus.action);
    const toastId = toast[feedback.tone](feedback.message, { id, position: "top-center" });
    if (feedback.tone === "loading") {
      pendingToasts.current.set(nextStatus.action, toastId);
    } else {
      pendingToasts.current.delete(nextStatus.action);
    }
  }, []);

  const reset = useCallback(() => {
    for (const id of pendingToasts.current.values()) toast.dismiss(id);
    pendingToasts.current.clear();
    setStatus(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const toasts = pendingToasts.current;
    return () => {
      mounted.current = false;
      for (const id of toasts.values()) toast.dismiss(id);
      toasts.clear();
    };
  }, []);

  const feedback = status ? clipboardFeedback(status) : null;
  return {
    status,
    onStatus,
    reset,
    message: feedback?.message,
    busyAction: feedback?.tone === "loading" ? status?.action : undefined,
  };
}
