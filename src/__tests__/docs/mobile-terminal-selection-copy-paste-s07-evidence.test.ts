import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = join(process.cwd(), "docs");
const evidencePath = join(docsRoot, "mobile-terminal-selection-copy-paste-s07-evidence.md");
const referenceDecisionsPath = join(docsRoot, "mobile-terminal-reference-decisions.md");

function readTrackedDoc(path: string) {
  const relativeToDocs = relative(docsRoot, path);
  expect(relativeToDocs).not.toMatch(/^\.\.(?:\/|$)/);
  expect(relativeToDocs).not.toMatch(/^\.git(?:\/|$)/);
  return readFileSync(path, "utf8");
}

const forbiddenPatterns: Array<[name: string, pattern: RegExp, fixture: string]> = [
  ["cloneProof key", /cloneProof/, "cloneProof=redacted"],
  ["example proof value", /proof-token/, "proof-token-redacted"],
  ["opaque session query", /session=[A-Za-z0-9_-]{8,}/, "session=abc12345"],
  ["opaque workspace id", /workspace-[A-Za-z0-9_-]{8,}/, "workspace-abc12345"],
  ["UUID-shaped opaque id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i, "123e4567-e89b-12d3-a456-426614174000"],
  ["agent checkout path", /\/home\/coder\//, "/home/coder/project"],
  ["macOS absolute user path", /\/Users\/[^\s)]+/, "/Users/example/project"],
  ["Windows absolute path", /[A-Za-z]:\\[^\s)]+/, "C:\\Users\\example"],
  ["Linux checkout-style path", /(?:^|\s)\/(?:tmp|var|opt|workspace|mnt)\/[^^\s)]+/, " /tmp/checkout"],
  ["private key marker", /BEGIN [A-Z ]*PRIVATE KEY/, "BEGIN PRIVATE KEY"],
  ["shell prompt fixture", /[$#] (pnpm|npm|git|ssh|cat|sed|curl)\b/, "$ pnpm test"],
  ["browser storage secret", /(?:localStorage|sessionStorage|cookie)=/i, "localStorage=secret"],
  ["HTTP endpoint", /https?:\/\/[^\s)]+/i, "https://example.invalid/path"],
  ["WebSocket endpoint", /wss?:\/\/[^\s)]+/i, "wss://example.invalid/socket"],
  ["SSH endpoint", /ssh:\/\/[^\s)]+/i, "ssh://example.invalid"],
];

describe("S07 mobile terminal selection copy paste evidence contract", () => {
  const evidence = readTrackedDoc(evidencePath);

  it("records the required evidence sections", () => {
    const requiredHeadings = [
      "# S07 Mobile Terminal Selection Copy Paste Evidence",
      "## Evidence status",
      "## Shipped Clipboard controls",
      "## Selection-mode behavior",
      "## Copy contract",
      "## Paste and fallback contract",
      "## Non-regression coverage",
      "## Device and environment",
      "## Redaction boundary",
      "## Acceptance decision",
      "## Evidence attachments checklist",
    ];

    for (const heading of requiredHeadings) {
      expect(evidence).toContain(heading);
    }
  });

  it("keeps S07 aligned with the reference decision to prefer visible controls and redacted diagnostics", () => {
    const referenceDecisions = readTrackedDoc(referenceDecisionsPath);

    expect(referenceDecisions).toContain("Visible accessible controls are the baseline");
    expect(referenceDecisions).toContain("Gestures are additive proof items");
    expect(referenceDecisions).toContain("Redaction is part of the feature");
    expect(evidence).toContain("visible Clipboard page");
    expect(evidence).toContain("Select, Copy, and Paste");
    expect(evidence).toContain("aria-live status message");
    expect(evidence).toContain("explicit mobile fallback");
  });

  it("requires blocked physical-device fields before accepting real-device or PWA evidence", () => {
    const requiredFieldLabels = [
      "Physical device used",
      "Device model",
      "Operating system and version",
      "Browser or installed PWA mode",
      "Runtime used for automated evidence",
      "First blocked link",
      "S07 real-device/PWA acceptance",
      "S07 native-like selection parity acceptance",
    ];

    for (const label of requiredFieldLabels) {
      expect(evidence).toMatch(new RegExp(`\\*\\*${label}:\\*\\*`));
    }

    expect(evidence).toContain(
      "blocked - no physical phone, mobile-browser, or installed PWA runtime was available",
    );
    expect(evidence).toContain("lack of physical phone, mobile-browser, or installed PWA runtime");

    const realDeviceAcceptance = evidence.match(
      /\*\*S07 real-device\/PWA acceptance:\*\* `([^`]+)`/,
    )?.[1];
    const nativeSelectionAcceptance = evidence.match(
      /\*\*S07 native-like selection parity acceptance:\*\* `([^`]+)`/,
    )?.[1];

    expect(realDeviceAcceptance).toBeDefined();
    expect(nativeSelectionAcceptance).toBeDefined();
    expect(realDeviceAcceptance).toMatch(/^blocked - /);
    expect(nativeSelectionAcceptance).toMatch(/^blocked - /);
    expect(realDeviceAcceptance).not.toMatch(/accepted|passed|verified/i);
    expect(nativeSelectionAcceptance).not.toMatch(/accepted|passed|verified/i);
  });

  it("accepts only the automated S07 scope and explicitly avoids physical runtime claims", () => {
    expect(evidence).toContain(
      "S07 automated Clipboard controls acceptance:** `accepted - visible controls",
    );
    expect(evidence).toContain("S07 copy contract acceptance:** `accepted - automated proof");
    expect(evidence).toContain("S07 paste/fallback contract acceptance:** `accepted - automated proof");
    expect(evidence).toContain("This record does not claim physical phone selection fidelity");
    expect(evidence).toContain(
      "Do not use this record to accept physical runtime behavior until that replacement evidence exists.",
    );
    expect(evidence).toContain(
      "Physical browser and installed-PWA acceptance remains blocked until a real device run records categorical observations",
    );
  });

  it("documents shipped controls, selection behavior, and categorical copy/paste contracts", () => {
    const requiredPhrases = [
      "Clipboard page with Select, Copy, and Paste actions",
      "Select:** toggles terminal selection mode",
      "Copy:** copies the active terminal selection",
      "Paste:** sends platform clipboard text",
      "typed categorical status callbacks",
      "mobile-only selection-mode forwarding",
      "Desktop terminal behavior remains unchanged",
    ];

    for (const phrase of requiredPhrases) {
      expect(evidence).toContain(phrase);
    }

    const safeCategories = [
      "`copied`",
      "`failed`",
      "`passthrough`",
      "`pasted`",
      "`empty`",
      "`fallback`",
      "`clipboard-api`",
      "`exec-command`",
      "`native-browser`",
      "`clipboard-api-unavailable`",
      "`clipboard-api-denied`",
      "`clipboard-api-failed`",
    ];

    for (const category of safeCategories) {
      expect(evidence).toContain(category);
    }
  });

  it("guards the S07 redaction boundary", () => {
    const requiredBoundaryPhrases = [
      "Do not paste terminal buffer or screen contents",
      "selected text",
      "pasted text",
      "helper textarea contents",
      "command input",
      "command output",
      "clone proof material",
      "proof tokens",
      "credential material",
      "private keys",
      "browser storage values",
      "upstream connection endpoints",
      "shell prompt snippets",
      "route or session identifiers shaped like real opaque values",
      "checkout-specific absolute paths",
      "operating-system absolute paths",
    ];

    for (const phrase of requiredBoundaryPhrases) {
      expect(evidence).toContain(phrase);
    }

    for (const [name, pattern] of forbiddenPatterns) {
      expect(evidence, name).not.toMatch(pattern);
    }
  });

  it("proves the forbidden-pattern guard rejects representative prohibited fixtures", () => {
    for (const [name, pattern, fixture] of forbiddenPatterns) {
      expect(fixture, name).toMatch(pattern);
    }
  });
});
