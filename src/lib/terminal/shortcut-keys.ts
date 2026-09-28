export interface TerminalKeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export const TERMINAL_SHORTCUT_KEYS = [
  ..."1234567890",
  ..."abcdefghijklmnopqrstuvwxyz",
  "Space",
  "Enter",
  "Tab",
  "Esc",
  "Backspace",
  "Delete",
  "Insert",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PgUp",
  "PgDn",
  ..."/\\[];'-=,.`",
  "?",
  "@",
  ":",
  "_",
  "+",
  "{",
  "}",
  "|",
  '"',
  "<",
  ">",
  "~",
  "!",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
] as const;

/** Standard VT keys, with CSI-u for combinations that legacy VT cannot distinguish. */
export function encodeTerminalShortcut(key: string, modifiers: TerminalKeyModifiers): string {
  const { ctrl, alt, shift } = modifiers;
  const modifier = 1 + Number(shift) + Number(alt) * 2 + Number(ctrl) * 4;
  const cursor: Record<string, string> = {
    Up: "A",
    Down: "B",
    Right: "C",
    Left: "D",
    Home: "H",
    End: "F",
  };
  if (cursor[key]) return `\x1b[${modifier === 1 ? "" : `1;${modifier}`}${cursor[key]}`;
  const tilde: Record<string, number> = {
    Insert: 2,
    Delete: 3,
    PgUp: 5,
    PgDn: 6,
    F5: 15,
    F6: 17,
    F7: 18,
    F8: 19,
    F9: 20,
    F10: 21,
    F11: 23,
    F12: 24,
  };
  if (tilde[key]) return `\x1b[${tilde[key]}${modifier === 1 ? "" : `;${modifier}`}~`;
  if (/^F[1-4]$/.test(key)) {
    const suffix = String.fromCharCode(79 + Number(key.slice(1)));
    return modifier === 1 ? `\x1bO${suffix}` : `\x1b[1;${modifier}${suffix}`;
  }
  if (key === "Tab" && shift && !ctrl && !alt) return "\x1b[Z";
  const special: Record<string, number> = { Space: 32, Enter: 13, Tab: 9, Esc: 27, Backspace: 127 };
  let character = key.length === 1 ? key : String.fromCharCode(special[key] ?? 0);
  if (character === "\0") return "";
  // Modified Enter and Ctrl+Shift combinations need distinct key identities.
  if (
    (key === "Enter" && (shift || ctrl)) ||
    (ctrl && shift) ||
    (ctrl && ["Tab", "Backspace"].includes(key))
  ) {
    return `\x1b[${character.codePointAt(0)};${modifier}u`;
  }
  if (ctrl) {
    const code = character.toUpperCase().charCodeAt(0);
    if (character === " ") character = "\0";
    else if (code >= 64 && code <= 95) character = String.fromCharCode(code - 64);
    else return `\x1b[${character.codePointAt(0)};${modifier}u`;
  } else if (shift && key.length === 1) {
    const unshifted = "1234567890-=[]\\;',./`";
    const shifted = '!@#$%^&*()_+{}|:"<>?~';
    const index = unshifted.indexOf(character);
    character = index >= 0 ? shifted[index] : character.toUpperCase();
  }
  return `${alt ? "\x1b" : ""}${character}`;
}
