import { expect, it } from "vitest";
import { MOBILE_SMART_KEYS } from "@/lib/terminal/mobile-smart-keys";

it("has one exact key label per terminal sequence", () => {
  expect(Object.fromEntries(MOBILE_SMART_KEYS.map((key) => [key.label, key.sequence]))).toEqual({
    Enter: "\r",
    Tab: "\t",
    Esc: "\x1b",
    Backspace: "\x7f",
    Up: "\x1b[A",
    Down: "\x1b[B",
    Left: "\x1b[D",
    Right: "\x1b[C",
    Space: " ",
    "Shift+Tab": "\x1b[Z",
    "Ctrl+C": "\x03",
    "Ctrl+D": "\x04",
    "Ctrl+L": "\x0c",
    "Ctrl+R": "\x12",
    "Ctrl+T": "\x14",
    "Ctrl+O": "\x0f",
  });
  expect(new Set(MOBILE_SMART_KEYS.map((key) => key.sequence)).size).toBe(MOBILE_SMART_KEYS.length);
});
