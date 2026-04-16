import type { ITheme } from "@xterm/xterm";

export const TERMINAL_THEME: ITheme = {
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  black: "#1a1a1a",
  brightBlack: "#444444",
  red: "#ff5555",
  brightRed: "#ff6e6e",
  green: "#50fa7b",
  brightGreen: "#69ff94",
  yellow: "#f1fa8c",
  brightYellow: "#ffffa5",
  blue: "#6272a4",
  brightBlue: "#8be9fd",
  magenta: "#ff79c6",
  brightMagenta: "#ff92d0",
  cyan: "#8be9fd",
  brightCyan: "#a4ffff",
  white: "#f8f8f2",
  brightWhite: "#ffffff",
};

export const TERMINAL_FONT_FAMILY = "'Fira Code', monospace";

export async function loadTerminalFont(): Promise<void> {
  try {
    await document.fonts.load("13px 'Fira Code'");
  } catch {
    // Font load failed — terminal will fall back to monospace
  }
}
