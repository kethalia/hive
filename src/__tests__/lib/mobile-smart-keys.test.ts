import { describe, expect, it } from "vitest";
import { MOBILE_SMART_KEY_PAGES, MOBILE_SMART_KEYS } from "@/lib/terminal/mobile-smart-keys";

function keySequenceByLabel() {
  return new Map(MOBILE_SMART_KEYS.map((key) => [key.label, key.sequence]));
}

describe("mobile smart key catalog", () => {
  it("groups fixed Blink-inspired smart keys into visible pages", () => {
    expect(
      MOBILE_SMART_KEY_PAGES.map(({ id, label, ariaLabel, keys }) => ({
        id,
        label,
        ariaLabel,
        keyLabels: keys.map((key) => key.label),
      })),
    ).toEqual([
      {
        id: "keys",
        label: "Keys",
        ariaLabel: "Terminal quick actions",
        keyLabels: ["Enter", "Tab", "Esc", "Backspace"],
      },
      {
        id: "control",
        label: "Control",
        ariaLabel: "Terminal control keys",
        keyLabels: ["Ctrl+C", "Ctrl+D", "Ctrl+L", "Ctrl+R"],
      },
      {
        id: "navigation",
        label: "Navigation",
        ariaLabel: "Terminal navigation keys",
        keyLabels: ["Up", "Down", "Left", "Right"],
      },
      {
        id: "position",
        label: "Position",
        ariaLabel: "Terminal position keys",
        keyLabels: ["Home", "End", "PgUp", "PgDn"],
      },
    ]);
  });

  it("uses exact terminal byte sequences for every fixed smart key", () => {
    expect(Object.fromEntries(keySequenceByLabel())).toEqual({
      Enter: "\r",
      Tab: "\t",
      Esc: "\x1b",
      Backspace: "\x7f",
      "Ctrl+C": "\x03",
      "Ctrl+D": "\x04",
      "Ctrl+L": "\x0c",
      "Ctrl+R": "\x12",
      Up: "\x1b[A",
      Down: "\x1b[B",
      Left: "\x1b[D",
      Right: "\x1b[C",
      Home: "\x1b[H",
      End: "\x1b[F",
      PgUp: "\x1b[5~",
      PgDn: "\x1b[6~",
    });
  });

  it("has no duplicate page ids, key ids, or visible key labels", () => {
    const pageIds = MOBILE_SMART_KEY_PAGES.map((page) => page.id);
    const keyIds = MOBILE_SMART_KEYS.map((key) => key.id);
    const labels = MOBILE_SMART_KEYS.map((key) => key.label);

    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(new Set(keyIds).size).toBe(keyIds.length);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
