import { encodeTerminalShortcut } from "./shortcut-keys";

/** One entry per sequence, named only for the key combination it sends. */
export const MOBILE_SMART_KEYS = [
  ...["Enter", "Tab", "Esc", "Backspace", "Up", "Down", "Left", "Right", "Space"].map((label) => ({
    label,
    sequence: encodeTerminalShortcut(label, { ctrl: false, alt: false, shift: false }),
  })),
  { label: "Shift+Tab", sequence: "\x1b[Z" },
  ...["C", "D", "L", "R", "T", "O"].map((key) => ({
    label: `Ctrl+${key}`,
    sequence: encodeTerminalShortcut(key, { ctrl: true, alt: false, shift: false }),
  })),
];
