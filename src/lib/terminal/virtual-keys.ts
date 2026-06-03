export const VIRTUAL_KEY_SEQUENCES = {
  Tab: "\t",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  CtrlC: "\x03",
  CtrlD: "\x04",
  CtrlL: "\x0c",
  CtrlR: "\x12",
  Esc: "\x1b",
  Enter: "\r",
  Backspace: "\x7f",
  Home: "\x1b[H",
  End: "\x1b[F",
  PgUp: "\x1b[5~",
  PgDn: "\x1b[6~",
} as const;

export type VirtualKeyName = keyof typeof VIRTUAL_KEY_SEQUENCES;
