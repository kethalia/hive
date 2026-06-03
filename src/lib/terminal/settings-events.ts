export const TERMINAL_SETTINGS_CHANGED_EVENT = "hive:terminal-settings-changed" as const;

export interface TerminalSettingsChangedDetail {
  terminalControlsBeyondMobile: boolean;
}

export type TerminalSettingsChangedEvent = CustomEvent<TerminalSettingsChangedDetail>;

export function dispatchTerminalSettingsChanged(detail: TerminalSettingsChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TerminalSettingsChangedDetail>(TERMINAL_SETTINGS_CHANGED_EVENT, { detail }),
  );
}
