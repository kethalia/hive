export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function preferredShortcut(keys: readonly string[], isApple = isApplePlatform()): string {
  return (
    keys.find((key) => (isApple ? key.includes("cmd") : !key.includes("cmd"))) ?? keys[0] ?? ""
  );
}

export function formatShortcut(keys: readonly string[], isApple = isApplePlatform()): string {
  return preferredShortcut(keys, isApple)
    .split("+")
    .filter(Boolean)
    .map((part) => {
      const key = part.trim().toLowerCase();
      if (key === "cmd") return "⌘";
      if (key === "ctrl") return "Ctrl";
      if (key === "alt") return isApple ? "⌥" : "Alt";
      if (key === "shift") return isApple ? "⇧" : "Shift";
      return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
    })
    .join(" + ");
}

// Shared by shortcut registration and the corresponding control's tooltip.
export const GLOBAL_COMMAND_PALETTE_KEYS = ["ctrl+k", "cmd+k"] as const;
export const WORKSPACE_AGENTS_KEYS = ["ctrl+alt+a", "cmd+alt+a"] as const;
export const MANAGE_WORKSPACES_KEYS = ["ctrl+alt+g", "cmd+alt+g"] as const;
export const PANE_CONTROL_SHORTCUTS = {
  microphone: { keys: ["ctrl+alt+m", "cmd+alt+m"], label: "Open microphone controls" },
  speaker: { keys: ["ctrl+alt+s", "cmd+alt+s"], label: "Open speaker controls" },
  actions: { keys: ["ctrl+alt+.", "cmd+alt+."], label: "Open pane actions" },
  close: { keys: ["ctrl+alt+x", "cmd+alt+x"], label: "Close focused pane" },
} as const;
