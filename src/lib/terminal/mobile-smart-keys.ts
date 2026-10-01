import { encodeTerminalShortcut } from "./shortcut-keys";

/** Base keys only; combinations are composed with the modifier toggles. */
export const MOBILE_SMART_KEYS = [
  "Enter",
  "Tab",
  "Esc",
  "Backspace",
  "Up",
  "Down",
  "Left",
  "Right",
  "Space",
].map((label) => ({
  label,
  sequence: encodeTerminalShortcut(label, { ctrl: false, alt: false, shift: false }),
}));
