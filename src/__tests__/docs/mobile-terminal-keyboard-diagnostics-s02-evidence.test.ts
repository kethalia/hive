import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const evidencePath = join(
  process.cwd(),
  "docs/mobile-terminal-keyboard-diagnostics-s02-evidence.md",
);
const uatPath = join(process.cwd(), "docs/mobile-terminal-keyboard-diagnostics-uat.md");

function readTrackedDoc(path: string) {
  return readFileSync(path, "utf8");
}

describe("S02 mobile terminal keyboard evidence contract", () => {
  const evidence = readTrackedDoc(evidencePath);

  it("links the fillable evidence record to the UAT runbook", () => {
    const uat = readTrackedDoc(uatPath);

    expect(uat).toContain("# Mobile Terminal Keyboard Diagnostics UAT");
    expect(evidence).toContain("./mobile-terminal-keyboard-diagnostics-uat.md");
  });

  it("contains the required evidence sections", () => {
    const requiredHeadings = [
      "# S02 Mobile Terminal Keyboard Evidence",
      "## Evidence status",
      "## Redaction boundary",
      "## Device and environment",
      "## Required acceptance observations",
      "## Snapshot A: keyboard closed before focus",
      "## Snapshot B: keyboard open",
      "## Snapshot C: keyboard closed after dismissal",
      "## tmux dimension observation",
      "## Acceptance decision",
      "## Failure notes",
      "## Evidence attachments checklist",
    ];

    for (const heading of requiredHeadings) {
      expect(evidence).toContain(heading);
    }
  });

  it("requires the real-device fields S02 needs before accepting R024 evidence", () => {
    const requiredFieldLabels = [
      "Device model",
      "Physical device used",
      "Operating system and version",
      "Browser or installed PWA mode",
      "Route/query shape used",
      "Terminal bottom remains visible while keyboard is open",
      "Keyboard inset becomes positive or visual viewport shrinks while keyboard is open",
      "xterm rows/cols change or are confirmed appropriate for the keyboard-open viewport",
      "Resize-sent rows/cols are observed after the keyboard-open refit",
      "tmux numeric dimensions match the propagated resize closely enough to accept",
      "xterm rows x cols",
      "Latest fit rows x cols and count",
      "Latest resize-request rows x cols and count",
      "Latest resize-sent rows x cols and count",
      "Terminal-bottom visibility result",
      "Rows observed",
      "Columns observed",
      "Matches latest resize-sent rows/cols",
    ];

    for (const label of requiredFieldLabels) {
      expect(evidence).toMatch(new RegExp(`\\*\\*${label}:\\*\\*`));
    }
  });

  it("keeps route capture to placeholder shape instead of sensitive session values", () => {
    expect(evidence).toContain(
      "/workspaces/<workspace-id>/terminal?session=<session-name>&debugViewport=1",
    );
    expect(evidence).not.toMatch(/session=[A-Za-z0-9_-]{8,}/);
    expect(evidence).not.toMatch(/workspace-[A-Za-z0-9_-]{8,}/);
  });

  it("guards the redaction boundary without normalizing sensitive debug payloads", () => {
    expect(evidence).toContain("Only record geometry, dimensions, timing, counters");
    expect(evidence).toContain(
      "If a copied diagnostic snapshot contains any of those values, stop",
    );

    const forbiddenPatterns: Array<[string, RegExp]> = [
      ["terminal text phrase", /terminal\s+text/i],
      ["terminal transcript phrase", /terminal\s+transcript/i],
      ["helper textarea value phrase", /helper\s+textarea\s+value/i],
      ["cloneProof key", /cloneProof/],
      ["clone proof phrase", /clone\s+proof/i],
      ["token term", /\btokens?\b/i],
      ["secret term", /\bsecrets?\b/i],
      ["raw local path phrase", /raw\s+local\s+paths?/i],
      ["agent checkout path", /\/home\/coder\//],
      ["macOS absolute user path", /\/Users\/[^\s)]+/],
      ["Windows absolute path", /[A-Za-z]:\\\\[^\s)]+/],
    ];

    for (const [name, pattern] of forbiddenPatterns) {
      expect(evidence, name).not.toMatch(pattern);
    }
  });
});
