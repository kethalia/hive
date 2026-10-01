import {
  encodeTerminalShortcut,
  TERMINAL_SHORTCUT_KEYS,
  type TerminalKeyModifiers,
} from "./shortcut-keys";

export const NO_MOBILE_MODIFIERS: TerminalKeyModifiers = Object.freeze({
  ctrl: false,
  alt: false,
  shift: false,
});
const states = new WeakMap<object, TerminalKeyModifiers>();
const listeners = new Set<() => void>();
export function subscribeMobileModifiers(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function getMobileModifiers(term: object | null): TerminalKeyModifiers {
  return term ? (states.get(term) ?? NO_MOBILE_MODIFIERS) : NO_MOBILE_MODIFIERS;
}
export function setMobileModifiers(term: object | null, modifiers: TerminalKeyModifiers) {
  if (!term) return;
  if (modifiers === NO_MOBILE_MODIFIERS) states.delete(term);
  else states.set(term, modifiers);
  for (const listener of listeners) listener();
}
const INPUT_KEYS: Record<string, string> = {
  ...Object.fromEntries(
    TERMINAL_SHORTCUT_KEYS.filter((key) => key.length > 1).map((key) => [
      encodeTerminalShortcut(key, NO_MOBILE_MODIFIERS),
      key,
    ]),
  ),
  // DECCKM application-cursor mode uses SS3 instead of CSI.
  "\x1bOA": "Up",
  "\x1bOB": "Down",
  "\x1bOC": "Right",
  "\x1bOD": "Left",
  "\x1bOH": "Home",
  "\x1bOF": "End",
};
/** Modify single keys; leave mouse reports and multi-character input batches intact. */
export function applyMobileModifiers(term: object, data: string): string {
  const modifiers = getMobileModifiers(term);
  if (!modifiers.ctrl && !modifiers.alt && !modifiers.shift) return data;
  const key =
    INPUT_KEYS[data] ?? (data.length === 1 && data >= " " && data !== "\x7f" ? data : undefined);
  if (!key) return data;
  setMobileModifiers(term, NO_MOBILE_MODIFIERS);
  return encodeTerminalShortcut(key, modifiers);
}
