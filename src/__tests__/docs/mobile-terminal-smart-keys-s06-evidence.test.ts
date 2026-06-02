import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = join(process.cwd(), "docs");
const evidencePath = join(docsRoot, "mobile-terminal-smart-keys-s06-evidence.md");
const referenceDecisionsPath = join(docsRoot, "mobile-terminal-reference-decisions.md");

function readTrackedDoc(path: string) {
  const relativeToDocs = relative(docsRoot, path);
  expect(relativeToDocs).not.toMatch(/^\.\.(?:\/|$)/);
  expect(relativeToDocs).not.toMatch(/^\.git(?:\/|$)/);
  return readFileSync(path, "utf8");
}

describe("S06 mobile terminal smart keys evidence contract", () => {
  const evidence = readTrackedDoc(evidencePath);

  it("records the required evidence sections", () => {
    const requiredHeadings = [
      "# S06 Mobile Terminal Smart Keys Evidence",
      "## Evidence status",
      "## Shipped smart-key catalog",
      "## Exact key sequence contract",
      "## No modifier latch or new gesture decision",
      "## Focus, typing, and scrollback non-regression",
      "## Device and environment",
      "## Redaction boundary",
      "## Acceptance decision",
      "## Evidence attachments checklist",
    ];

    for (const heading of requiredHeadings) {
      expect(evidence).toContain(heading);
    }
  });

  it("keeps S06 aligned with the reference decision to prefer visible controls before gestures", () => {
    const referenceDecisions = readTrackedDoc(referenceDecisionsPath);

    expect(referenceDecisions).toContain("Visible accessible controls are the baseline");
    expect(referenceDecisions).toContain("Gestures are additive proof items");
    expect(evidence).toContain("visible, Blink-inspired controls");
    expect(evidence).toContain("No modifier latch shipped");
    expect(evidence).toContain("No new smart-key gesture shipped");
    expect(evidence).toContain("Smart keys are visible buttons");
    expect(evidence).toContain("visible controls remain the accepted baseline");
  });

  it("documents every shipped page and smart-key label", () => {
    const expectedPageRows = [
      "**Keys:** Enter, Tab, Esc, Backspace.",
      "**Control:** Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+R.",
      "**Navigation:** Up, Down, Left, Right.",
      "**Position:** Home, End, PgUp, PgDn.",
    ];

    for (const row of expectedPageRows) {
      expect(evidence).toContain(row);
    }

    const requiredLabels = [
      "Enter",
      "Tab",
      "Esc",
      "Backspace",
      "Ctrl+C",
      "Ctrl+D",
      "Ctrl+L",
      "Ctrl+R",
      "Up",
      "Down",
      "Left",
      "Right",
      "Home",
      "End",
      "PgUp",
      "PgDn",
    ];

    for (const label of requiredLabels) {
      expect(evidence).toMatch(new RegExp(`\\| [^|]*${label.replace("+", "\\+")}[^|]* \\|`));
    }
  });

  it("documents the exact smart-key sequence contract", () => {
    const requiredSequenceRows = [
      "| Keys | Enter | carriage return | `\\r` |",
      "| Keys | Tab | horizontal tab | `\\t` |",
      "| Keys | Esc | escape | `\\x1b` |",
      "| Keys | Backspace | delete | `\\x7f` |",
      "| Control | Ctrl+C | interrupt | `\\x03` |",
      "| Control | Ctrl+D | end of transmission | `\\x04` |",
      "| Control | Ctrl+L | form feed clear-screen | `\\x0c` |",
      "| Control | Ctrl+R | reverse search | `\\x12` |",
      "| Navigation | Up | cursor up | `\\x1b[A` |",
      "| Navigation | Down | cursor down | `\\x1b[B` |",
      "| Navigation | Left | cursor left | `\\x1b[D` |",
      "| Navigation | Right | cursor right | `\\x1b[C` |",
      "| Position | Home | cursor home | `\\x1b[H` |",
      "| Position | End | cursor end | `\\x1b[F` |",
      "| Position | PgUp | page up | `\\x1b[5~` |",
      "| Position | PgDn | page down | `\\x1b[6~` |",
    ];

    for (const row of requiredSequenceRows) {
      expect(evidence).toContain(row);
    }
  });

  it("requires blocked device/runtime fields before accepting real-device or PWA evidence", () => {
    const requiredFieldLabels = [
      "Physical device used",
      "Device model",
      "Operating system and version",
      "Browser or installed PWA mode",
      "Runtime used for automated evidence",
      "First blocked link",
      "S06 real-device/PWA acceptance",
    ];

    for (const label of requiredFieldLabels) {
      expect(evidence).toMatch(new RegExp(`\\*\\*${label}:\\*\\*`));
    }

    expect(evidence).toContain(
      "blocked - no physical phone, mobile-browser, or installed PWA runtime was available",
    );
    expect(evidence).toContain("lack of physical phone, mobile-browser, or installed PWA runtime");

    const realDeviceAcceptance = evidence.match(
      /\*\*S06 real-device\/PWA acceptance:\*\* `([^`]+)`/,
    )?.[1];
    expect(realDeviceAcceptance).toBeDefined();
    expect(realDeviceAcceptance).toMatch(/^blocked - /);
    expect(realDeviceAcceptance).not.toMatch(/accepted|passed|verified/i);
  });

  it("documents focus, typing, scrollback, and existing control non-regression without over-claiming", () => {
    expect(evidence).toContain("active terminal sender");
    expect(evidence).toContain("pointer or mouse down on controls prevents focus transfer");
    expect(evidence).toContain("direct-typing path");
    expect(evidence).toContain("existing mobile terminal controls seam");
    expect(evidence).toContain("Windows, Compose, and Font size pages");
    expect(evidence).toContain(
      "does not claim native selection, clipboard, or hardware-keyboard acceptance",
    );
    expect(evidence).toContain(
      "does not claim R024 keyboard acceptance or S07 clipboard and selection acceptance",
    );
  });

  it("guards the S06 redaction boundary", () => {
    expect(evidence).toContain("Do not paste terminal buffer or screen contents");
    expect(evidence).toContain("helper textarea contents");
    expect(evidence).toContain("command input");
    expect(evidence).toContain("clone proof material");
    expect(evidence).toContain("proof tokens");
    expect(evidence).toContain("credential material");
    expect(evidence).toContain("route or session identifiers shaped like real opaque values");

    const forbiddenPatterns: Array<[string, RegExp]> = [
      ["cloneProof key", /cloneProof/],
      ["example proof value", /proof-token/],
      ["opaque session query", /session=[A-Za-z0-9_-]{8,}/],
      ["opaque workspace id", /workspace-[A-Za-z0-9_-]{8,}/],
      ["agent checkout path", /\/home\/coder\//],
      ["macOS absolute user path", /\/Users\/[^\s)]+/],
      ["Windows absolute path", /[A-Za-z]:\\\\[^\s)]+/],
      ["private key marker", /BEGIN [A-Z ]*PRIVATE KEY/],
      ["shell prompt fixture", /[$#] (pnpm|npm|git|ssh)\b/],
      ["browser storage secret", /(?:localStorage|sessionStorage|cookie)=/i],
      ["upstream endpoint", /wss?:\/\/[^\s)]+/i],
    ];

    for (const [name, pattern] of forbiddenPatterns) {
      expect(evidence, name).not.toMatch(pattern);
    }
  });
});
