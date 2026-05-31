export const VIRTUAL_KEY_SEQUENCES = {
  Tab: "\t",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  CtrlC: "\x03",
  Esc: "\x1b",
  Enter: "\r",
} as const;

export type VirtualKeyName = keyof typeof VIRTUAL_KEY_SEQUENCES;
