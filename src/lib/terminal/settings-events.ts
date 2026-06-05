export const TERMINAL_SETTINGS_CHANGED_EVENT = "hive:terminal-settings-changed" as const;

export interface TerminalSettingsChangedDetail {
  terminalControlsBeyondMobile: boolean;
}

export type TerminalSettingsChangedEvent = CustomEvent<TerminalSettingsChangedDetail>;

export function isTerminalSettingsChangedDetail(
  value: unknown,
): value is TerminalSettingsChangedDetail {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TerminalSettingsChangedDetail>;
  return typeof candidate.terminalControlsBeyondMobile === "boolean";
}

export function dispatchTerminalSettingsChanged(detail: TerminalSettingsChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TerminalSettingsChangedDetail>(TERMINAL_SETTINGS_CHANGED_EVENT, { detail }),
  );
}
