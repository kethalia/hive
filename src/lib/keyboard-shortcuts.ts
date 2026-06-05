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
