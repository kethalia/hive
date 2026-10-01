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
