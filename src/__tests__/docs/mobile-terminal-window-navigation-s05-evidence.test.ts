import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const evidencePath = join(process.cwd(), "docs/mobile-terminal-window-navigation-s05-evidence.md");
const referenceDecisionsPath = join(process.cwd(), "docs/mobile-terminal-reference-decisions.md");

function readTrackedDoc(path: string) {
  return readFileSync(path, "utf8");
}

describe("S05 mobile terminal window navigation evidence contract", () => {
  const evidence = readTrackedDoc(evidencePath);

  it("records the required evidence sections", () => {
    const requiredHeadings = [
      "# S05 Mobile Terminal Window Navigation Evidence",
      "## Evidence status",
      "## Shipped accessible controls",
      "## Route switching evidence",
      "## Two-finger swipe comparison",
      "## Device and environment",
      "## Redaction boundary",
      "## Acceptance decision",
      "## Evidence attachments checklist",
    ];

    for (const heading of requiredHeadings) {
      expect(evidence).toContain(heading);
    }
  });

  it("keeps S05 aligned with the reference decision to prefer visible controls before gestures", () => {
    const referenceDecisions = readTrackedDoc(referenceDecisionsPath);

    expect(referenceDecisions).toContain("Visible accessible controls are the baseline");
    expect(referenceDecisions).toContain("Gestures are additive proof items");
    expect(evidence).toContain("Explicit controls shipped");
    expect(evidence).toContain("Two-finger swipe status:** `deferred");
    expect(evidence).toContain("No new gesture introduced");
  });

  it("requires device/runtime fields before accepting real-device or PWA evidence", () => {
    const requiredFieldLabels = [
      "Physical device used",
      "Device model",
      "Operating system and version",
      "Browser or installed PWA mode",
      "Runtime used for automated evidence",
      "debugViewport flag observed",
      "S05 real-device/PWA acceptance",
    ];

    for (const label of requiredFieldLabels) {
      expect(evidence).toMatch(new RegExp(`\\*\\*${label}:\\*\\*`));
    }

    expect(evidence).toContain(
      "blocked - no physical phone browser or installed PWA runtime was available",
    );
  });

  it("documents the route-switching contract without normalizing clone or local evidence", () => {
    expect(evidence).toContain(
      "/workspaces/<workspace-id>/terminal?session=<session-name>&debugViewport=1",
    );
    expect(evidence).toContain("Clone parameter stripping on generic selection");
    expect(evidence).toContain("debugViewport=1 preservation");
    expect(evidence).toContain("One mounted terminal retained");
    expect(evidence).not.toMatch(/session=[A-Za-z0-9_-]{8,}/);
    expect(evidence).not.toMatch(/workspace-[A-Za-z0-9_-]{8,}/);
  });

  it("guards the S05 redaction boundary", () => {
    expect(evidence).toContain("Do not paste terminal buffer or screen contents");
    expect(evidence).toContain("helper textarea contents");
    expect(evidence).toContain("command input");
    expect(evidence).toContain("clone proof material");
    expect(evidence).toContain("credential material");

    const forbiddenPatterns: Array<[string, RegExp]> = [
      ["cloneProof key", /cloneProof/],
      ["example proof value", /proof-token/],
      ["agent checkout path", /\/home\/coder\//],
      ["macOS absolute user path", /\/Users\/[^\s)]+/],
      ["Windows absolute path", /[A-Za-z]:\\\\[^\s)]+/],
      ["private key marker", /BEGIN [A-Z ]*PRIVATE KEY/],
      ["shell prompt fixture", /[$#] (pnpm|npm|git|ssh)\b/],
    ];

    for (const [name, pattern] of forbiddenPatterns) {
      expect(evidence, name).not.toMatch(pattern);
    }
  });
});
