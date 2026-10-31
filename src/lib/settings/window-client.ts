import { SETTINGS_UNAVAILABLE, settingsWindowSchema } from "./window-contracts";

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
