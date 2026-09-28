import { describe, expect, it } from "vitest";
import { encodeTerminalShortcut } from "@/lib/terminal/shortcut-keys";

const base = { ctrl: false, alt: false, shift: false };
describe("terminal shortcut encoding", () => {
  it.each([
    ["Enter", {}, "\r"],
    ["Space", {}, " "],
    ["Tab", { shift: true }, "\x1b[Z"],
    ["j", { ctrl: true }, "\n"],
    ["o", { ctrl: true }, "\x0f"],
    ["t", { ctrl: true }, "\x14"],
    ["g", { ctrl: true }, "\x07"],
    ["r", { alt: true }, "\x1br"],
    ["Enter", { shift: true }, "\x1b[13;2u"],
    ["Up", { ctrl: true }, "\x1b[1;5A"],
    ["PgDn", {}, "\x1b[6~"],
    ["F1", {}, "\x1bOP"],
    ["F12", {}, "\x1b[24~"],
    ["1", { shift: true }, "!"],
    ["/", { shift: true }, "?"],
    ["t", { ctrl: true, shift: true }, "\x1b[116;6u"],
  ])("encodes %s with %j", (key, modifiers, expected) => {
    expect(encodeTerminalShortcut(key, { ...base, ...modifiers })).toBe(expected);
  });
});
