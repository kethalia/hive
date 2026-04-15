"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";

export type HydrationState = "idle" | "loading" | "hydrated" | "error";

interface UseScrollbackHydrationProps {
  reconnectId: string | null;
  terminalRef: React.RefObject<Terminal | null>;
  isConnected: boolean;
}

interface UseScrollbackHydrationReturn {
  hydrationState: HydrationState;
  isGatingLiveData: boolean;
}

export function useScrollbackHydration({
  reconnectId,
  terminalRef,
  isConnected,
}: UseScrollbackHydrationProps): UseScrollbackHydrationReturn {
  const [hydrationState, setHydrationState] = useState<HydrationState>("idle");
  const stateRef = useRef<HydrationState>("idle");

  useEffect(() => {
    if (!isConnected || !reconnectId) return;
    if (stateRef.current !== "idle") return;

    let cancelled = false;
    stateRef.current = "loading";
    console.log(`[hydration] State transition: idle → loading (reconnectId=${reconnectId})`);
    setHydrationState("loading");

    fetch(`/api/terminal/scrollback?reconnectId=${reconnectId}&limit=50`)
      .then(async (res) => {
        if (cancelled) return;

        if (!res.ok) {
          throw new Error(`Scrollback fetch failed: ${res.status}`);
        }

        const contentLength = res.headers.get("Content-Length");
        if (contentLength === "0" || !res.body) {
          console.log("[hydration] State transition: loading → hydrated (no scrollback data)");
          stateRef.current = "hydrated";
          setHydrationState("hydrated");
          return;
        }

        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        const data = new Uint8Array(buffer);
        if (data.byteLength > 0 && terminalRef.current) {
          terminalRef.current.write(data);
        }

        console.log(`[hydration] State transition: loading → hydrated (${data.byteLength} bytes)`);
        stateRef.current = "hydrated";
        setHydrationState("hydrated");
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(`[hydration] Fetch failed for reconnectId=${reconnectId}:`, err.message);
        console.log("[hydration] State transition: loading → error");
        stateRef.current = "error";
        setHydrationState("error");
      });

    return () => {
      cancelled = true;
      if (stateRef.current === "loading") {
        stateRef.current = "idle";
        setHydrationState("idle");
      }
    };
  }, [isConnected, reconnectId, terminalRef]);

  return {
    hydrationState,
    isGatingLiveData: hydrationState === "loading",
  };
}
