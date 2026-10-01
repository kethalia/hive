import { expect, it } from "vitest";
import {
  applyMobileModifiers,
  getMobileModifiers,
  setMobileModifiers,
} from "@/lib/terminal/mobile-modifiers";

it("isolates modifier state by terminal and does not consume it for protocol or batch data", () => {
  const terminal = {};
  const other = {};
  setMobileModifiers(terminal, { ctrl: true, alt: false, shift: false });
  for (const data of ["\x1b[<0;1;1M", "pasted text", "\x1b[200~c\x1b[201~", "你好"]) {
    expect(applyMobileModifiers(terminal, data)).toBe(data);
    expect(getMobileModifiers(terminal).ctrl).toBe(true);
  }
  expect(applyMobileModifiers(other, "c")).toBe("c");
  expect(applyMobileModifiers(terminal, "c")).toBe("\x03");
  expect(getMobileModifiers(terminal).ctrl).toBe(false);
});

it.each([
  ["A", "5", { ctrl: true, alt: false, shift: false }],
  ["B", "3", { ctrl: false, alt: true, shift: false }],
  ["C", "2", { ctrl: false, alt: false, shift: true }],
  ["D", "8", { ctrl: true, alt: true, shift: true }],
] as const)("modifies application-cursor arrow %s and consumes the toggles", (direction, parameter, modifiers) => {
  const terminal = {};
  const input = `\x1bO${direction}`;
  expect(applyMobileModifiers(terminal, input)).toBe(input);
  setMobileModifiers(terminal, modifiers);
  expect(applyMobileModifiers(terminal, input)).toBe(`\x1b[1;${parameter}${direction}`);
  expect(getMobileModifiers(terminal)).toEqual({ ctrl: false, alt: false, shift: false });
  expect(applyMobileModifiers(terminal, "c")).toBe("c");
});

it.each([
  ["\x1b[H", "\x1b[1;5H"],
  ["\x1bOH", "\x1b[1;5H"],
  ["\x1b[F", "\x1b[1;5F"],
  ["\x1bOF", "\x1b[1;5F"],
  ["\x1b[2~", "\x1b[2;5~"],
  ["\x1b[3~", "\x1b[3;5~"],
  ["\x1b[5~", "\x1b[5;5~"],
  ["\x1b[6~", "\x1b[6;5~"],
  ...["P", "Q", "R", "S"].map((key) => [`\x1bO${key}`, `\x1b[1;5${key}`]),
  ...[15, 17, 18, 19, 20, 21, 23, 24].map((key) => [`\x1b[${key}~`, `\x1b[${key};5~`]),
])("applies Ctrl to hardware special key %s without leaving it armed", (input, expected) => {
  const terminal = {};
  setMobileModifiers(terminal, { ctrl: true, alt: false, shift: false });
  expect(applyMobileModifiers(terminal, input)).toBe(expected);
  expect(getMobileModifiers(terminal).ctrl).toBe(false);
  expect(applyMobileModifiers(terminal, "c")).toBe("c");
});
