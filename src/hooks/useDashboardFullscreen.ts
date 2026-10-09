"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type KeyboardLock = {
  lock: (keys: string[]) => Promise<void>;
  unlock: () => void;
};

function getKeyboardLock() {
  const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
  return typeof keyboard?.lock === "function" && typeof keyboard.unlock === "function"
    ? (keyboard as KeyboardLock)
    : undefined;
}

function exitRootFullscreen() {
  if (document.fullscreenElement === document.documentElement) {
    // Cleanup has no mounted controller to report errors to.
    void document.exitFullscreen().catch(() => undefined);
  }
}

export function useDashboardFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    let nativeFullscreen = false;
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === document.documentElement;
      // Ignore fullscreen changes from other elements when using the CSS fallback.
      if (active || nativeFullscreen) {
        fullscreenRef.current = active;
        setFullscreen(active);
      }
      nativeFullscreen = active;
      if (!active) getKeyboardLock()?.unlock();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      getKeyboardLock()?.unlock();
      exitRootFullscreen();
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (fullscreen) root.dataset.dashboardFullscreen = "true";
    else delete root.dataset.dashboardFullscreen;
    return () => {
      delete root.dataset.dashboardFullscreen;
    };
  }, [fullscreen]);

  const toggleFullscreen = useCallback(() => {
    if (pendingRef.current) return;
    const root = document.documentElement;
    const next = !fullscreenRef.current;
    fullscreenRef.current = next;
    setFullscreen(next);

    if (!next) {
      getKeyboardLock()?.unlock();
      if (document.fullscreenElement === root) {
        pendingRef.current = true;
        void document
          .exitFullscreen()
          .catch(() => {
            if (!mountedRef.current) return;
            const active = document.fullscreenElement === root;
            fullscreenRef.current = active;
            setFullscreen(active);
            toast.error("Could not exit browser fullscreen. Try the shortcut again.");
          })
          .finally(() => {
            pendingRef.current = false;
          });
      }
      return;
    }

    // Some mobile browsers only support the CSS fullscreen layout.
    if (!root.requestFullscreen) return;
    pendingRef.current = true;
    void root
      .requestFullscreen()
      .then(() => {
        if (!mountedRef.current) {
          exitRootFullscreen();
          return;
        }
        if (document.fullscreenElement !== root) return;
        // Lock only Escape, preserving browser shortcuts and terminal key handling.
        // Permission denial must not undo a successful fullscreen request.
        const keyboard = getKeyboardLock();
        if (keyboard) {
          void keyboard.lock(["Escape"]).then(
            () => {
              if (!mountedRef.current || document.fullscreenElement !== root) keyboard.unlock();
            },
            () => undefined,
          );
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          toast.error("Browser fullscreen was blocked. The expanded layout is still available.");
        }
      })
      .finally(() => {
        pendingRef.current = false;
      });
  }, []);

  return { fullscreen, toggleFullscreen };
}
