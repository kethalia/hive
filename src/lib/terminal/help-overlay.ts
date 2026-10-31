export const OPEN_KEYBINDING_HELP_EVENT = "hive:open-keybinding-help";

export function openKeybindingHelp() {
  window.dispatchEvent(new Event(OPEN_KEYBINDING_HELP_EVENT));
}
