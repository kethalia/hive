import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = join(process.cwd(), "docs");
const evidencePath = join(docsRoot, "desktop-tablet-terminal-uat.md");

function readTrackedDoc(path: string) {
  const relativeToDocs = relative(docsRoot, path);
  expect(relativeToDocs).not.toMatch(/^\.\.(?:\/|$)/);
  expect(relativeToDocs).not.toMatch(/^\.git(?:\/|$)/);
  expect(relativeToDocs).not.toMatch(/^\.gsd(?:\/|$)/);
  expect(relativeToDocs).not.toMatch(/^\.planning(?:\/|$)/);
  expect(relativeToDocs).not.toMatch(/^\.audits(?:\/|$)/);
  return readFileSync(path, "utf8");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fieldValue(markdown: string, label: string) {
  return markdown.match(new RegExp(`\\*\\*${escapeRegExp(label)}:\\*\\* ` + "`([^`]+)`"))?.[1];
}

function section(markdown: string, heading: string) {
  const start = markdown.indexOf(heading);
  expect(start, `${heading} start`).toBeGreaterThanOrEqual(0);
  const next = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, next === -1 ? markdown.length : next);
}

const requiredHeadings = [
  "# Desktop Tablet Terminal UAT Evidence",
  "## Evidence status",
  "## Scope and requirements",
  "## Automated regression baseline",
  "## Browser viewport matrix",
  "## Terminal route UAT",
  "## Multi-session workspace UAT",
  "## Tablet touch and gesture-cancellation evidence",
  "## Live tmux/runtime evidence",
  "## Blocked operational evidence",
  "## Redaction boundary",
  "## Acceptance decision",
  "## Evidence attachments checklist",
];

const viewportHeadings = [
  "### Desktop viewport row",
  "### Laptop viewport row",
  "### Tablet viewport row",
];

const viewportFieldLabels = [
  "Viewport class",
  "Viewport size",
  "Device scale factor",
  "Browser mode",
  "Route shape checked",
  "Workspace route shape checked",
  "Terminal route status",
  "Multi-session workspace status",
  "Controls checked",
  "Acceptance status",
];

const forbiddenPatterns: Array<[name: string, pattern: RegExp, fixture: string]> = [
  ["terminal buffer value", /terminalBuffer=/, "terminalBuffer=redacted"],
  ["clipboard text value", /clipboard(?:Text|Contents)=/i, "clipboardText=redacted"],
  ["command input value", /commandInput=/, "commandInput=redacted"],
  ["command output value", /commandOutput=/, "commandOutput=redacted"],
  ["cloneProof key", /cloneProof/, "cloneProof=redacted"],
  ["example proof value", /proof-token/, "proof-token-redacted"],
  ["credential assignment", /(?:password|apiKey|secret)=/i, "apiKey=redacted"],
  ["browser storage secret", /(?:localStorage|sessionStorage|cookie)=/i, "localStorage=secret"],
  ["opaque session query", /session=[A-Za-z0-9_-]{8,}/, "session=abc12345"],
  ["opaque workspace id", /workspace-[A-Za-z0-9_-]{8,}/, "workspace-abc12345"],
  [
    "UUID-shaped opaque id",
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    "123e4567-e89b-12d3-a456-426614174000",
  ],
  ["agent checkout path", /\/home\/coder\//, "/home/coder/project"],
  ["macOS absolute user path", /\/Users\/[^\s)]+/, "/Users/example/project"],
  ["Windows absolute path", /[A-Za-z]:\\[^\s)]+/, "C:\\Users\\example"],
  [
    "Linux checkout-style path",
    /(?:^|\s)\/(?:tmp|var|opt|workspace|mnt)\/[^\s)]+/,
    " /tmp/checkout",
  ],
  ["HTTP endpoint", /https?:\/\/[^\s)]+/i, "https://example.invalid/path"],
  ["WebSocket endpoint", /wss?:\/\/[^\s)]+/i, "wss://example.invalid/socket"],
  ["SSH endpoint", /ssh:\/\/[^\s)]+/i, "ssh://example.invalid"],
  ["private key marker", /BEGIN [A-Z ]*PRIVATE KEY/, "BEGIN PRIVATE KEY"],
  ["shell prompt fixture", /[$#] (pnpm|npm|git|ssh|cat|sed|curl)\b/, "$ pnpm test"],
];

describe("S06 desktop tablet terminal UAT evidence contract", () => {
  const evidence = readTrackedDoc(evidencePath);

  it("records the required evidence sections", () => {
    for (const heading of requiredHeadings) {
      expect(evidence).toContain(heading);
    }
  });

  it("records a truthful pending or blocked UAT state without live-validation claims", () => {
    expect(fieldValue(evidence, "Overall S06 evidence status")).toMatch(/^(pre-UAT|blocked) - /);
    expect(fieldValue(evidence, "Browser viewport matrix status")).toMatch(/^(pending|blocked) - /);
    expect(fieldValue(evidence, "Terminal route UAT status")).toMatch(/^(pending|blocked) - /);
    expect(fieldValue(evidence, "Multi-session workspace UAT status")).toMatch(/^(pending|blocked) - /);
    expect(fieldValue(evidence, "Tablet touch and gesture-cancellation status")).toMatch(
      /^(pending|blocked) - /,
    );
    expect(fieldValue(evidence, "Live tmux/runtime status")).toMatch(/^blocked - /);
    expect(fieldValue(evidence, "Blocked operational status")).toMatch(/^blocked - /);
  });

  it("covers the S06 requirements and keeps R024/R026 deferred until physical or PWA evidence exists", () => {
    const requiredRequirementFields = [
      "R027 viewport and layout coverage",
      "R028 live terminal runtime coverage",
      "R029 multi-session workspace coverage",
      "R030 tablet touch coverage",
      "R012 diagnostic and failure-surface coverage",
      "R013 persistence and continuity coverage",
      "R024 mobile keyboard evidence",
      "R026 physical/PWA terminal behavior evidence",
    ];

    for (const label of requiredRequirementFields) {
      expect(fieldValue(evidence, label), label).toBeDefined();
    }

    expect(fieldValue(evidence, "R028 live terminal runtime coverage")).toMatch(/^blocked - /);
    expect(fieldValue(evidence, "R024 mobile keyboard evidence")).toMatch(/^deferred - /);
    expect(fieldValue(evidence, "R026 physical/PWA terminal behavior evidence")).toMatch(/^deferred - /);
    expect(evidence).toContain(
      "R024 and R026 remain deferred unless true physical browser or installed-PWA evidence is later attached",
    );
  });

  it("requires field labels for desktop, laptop, and tablet viewport rows", () => {
    for (const heading of viewportHeadings) {
      const row = section(evidence, heading);
      for (const label of viewportFieldLabels) {
        expect(row, `${heading} ${label}`).toMatch(
          new RegExp(`\\*\\*${escapeRegExp(label)}:\\*\\*`),
        );
      }
    }
  });

  it("uses only placeholder route shapes for terminal and multi-session workspace UAT", () => {
    expect(evidence).toContain("/workspaces/<workspace-id>/terminal");
    expect(evidence).toContain("/workspaces/<workspace-id>/terminal/workspace");
    expect(fieldValue(evidence, "Terminal route shape")).toBe("/workspaces/<workspace-id>/terminal");
    expect(fieldValue(evidence, "Workspace route shape")).toBe(
      "/workspaces/<workspace-id>/terminal/workspace",
    );
    expect(fieldValue(evidence, "Runtime route shape")).toBe("/workspaces/<workspace-id>/terminal");
  });

  it("requires live-runtime and blocked-operational evidence fields", () => {
    const liveRuntimeFields = [
      "Live tmux runtime status",
      "Terminal proxy connection status",
      "Session create or attach status",
      "Resize propagation status",
      "Runtime route shape",
      "R028 live-runtime acceptance",
    ];

    const blockedEvidenceFields = [
      "First blocked link",
      "Blocked proof type",
      "Unavailable runtime",
      "Replacement evidence required",
      "Can automated evidence substitute",
    ];

    for (const label of [...liveRuntimeFields, ...blockedEvidenceFields]) {
      expect(fieldValue(evidence, label), label).toBeDefined();
    }

    expect(fieldValue(evidence, "Can automated evidence substitute")).toMatch(/^no - /);
  });

  it("prevents blocked live-runtime acceptance fields from claiming pass or verification", () => {
    const blockedLiveAcceptanceFields = [
      "R028 live-runtime acceptance",
      "Live tmux runtime status",
      "Terminal proxy connection status",
      "Session create or attach status",
      "Resize propagation status",
    ];

    for (const label of blockedLiveAcceptanceFields) {
      const value = fieldValue(evidence, label);
      expect(value, label).toBeDefined();
      expect(value, label).toMatch(/^blocked - /);
      expect(value, label).not.toMatch(/\b(accepted|passed|verified)\b/i);
    }
  });

  it("guards the redaction boundary", () => {
    const requiredBoundaryPhrases = [
      "Do not paste terminal buffers",
      "clipboard contents",
      "helper textarea contents",
      "command input",
      "command output",
      "clone proof material",
      "proof tokens",
      "credential material",
      "browser storage values",
      "upstream HTTP endpoints",
      "upstream WebSocket endpoints",
      "upstream SSH endpoints",
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
