import type { CoderDisconnectRequest } from "@hive/auth";
import {
  coderDisconnectResultSchema,
  SETTINGS_UNAVAILABLE,
  settingsWindowSchema,
} from "./window-contracts";

export async function fetchSettingsWindow(signal: AbortSignal) {
  try {
    const response = await fetch("/api/settings/window", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error(SETTINGS_UNAVAILABLE);
    return settingsWindowSchema.parse(await response.json());
  } catch {
    signal.throwIfAborted();
    throw new Error(SETTINGS_UNAVAILABLE);
  }
}

/** Never retry an uncertain disconnect: its local authority may already be gone. */
export async function disconnectCoderConnection(input: CoderDisconnectRequest) {
  const response = await fetch("/api/auth/coder/disconnect", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    if (response.status === 409) throw new Error("connection_changed");
    throw new Error("disconnect_unknown");
  }
  return coderDisconnectResultSchema.parse(await response.json());
}
