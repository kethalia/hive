#!/usr/bin/env node
import { readFileSync } from "node:fs";

const evidencePath = "docs/mobile-terminal-keyboard-diagnostics-s02-evidence.md";
let evidence;
try {
  evidence = readFileSync(evidencePath, "utf8");
} catch (error) {
  console.error(`FAIL evidence artifact is readable: ${error.message}`);
  process.exit(1);
}

function field(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = "- \\*\\*" + escaped + ":\\*\\*\\s*`([^`]*)`";
  const match = evidence.match(new RegExp(pattern));
  return match?.[1]?.trim() ?? "";
}

function isYes(value) {
  return /^yes(?:\b|\s|-|,|\.)/i.test(value.trim());
}

function hasPositiveDimensionEvidence(value) {
  const normalized = value.toLowerCase();
  if (!value || /pending|blocked|not observed|not available|no real-device|no real device/.test(normalized)) {
    return false;
  }
  return /\d+/.test(value) || isYes(value) || /observed|accepted|changed|confirmed|matches/.test(normalized);
}

const checks = [
  {
    name: "Run status is accepted, not BLOCKED or PENDING",
    ok: () => {
      const value = field("Run status");
      return Boolean(value) && !/blocked|pending/i.test(value);
    },
  },
  {
    name: "Physical device used is yes",
    ok: () => isYes(field("Physical device used")),
  },
  {
    name: "Terminal bottom remains visible while keyboard is open is yes",
    ok: () => isYes(field("Terminal bottom remains visible while keyboard is open")),
  },
  {
    name: "Keyboard inset or visualViewport shrink observed",
    ok: () => hasPositiveDimensionEvidence(field("Keyboard inset becomes positive or visual viewport shrinks while keyboard is open")),
  },
  {
    name: "Resize-sent rows/cols observed after keyboard-open refit",
    ok: () => hasPositiveDimensionEvidence(field("Resize-sent rows/cols are observed after the keyboard-open refit")),
  },
  {
    name: "tmux resize observation accepted is yes",
    ok: () => isYes(field("tmux resize observation accepted")),
  },
  {
    name: "S02 real-device evidence accepted is yes",
    ok: () => isYes(field("S02 real-device evidence accepted")),
  },
  {
    name: "No required PENDING or not-observed fields remain",
    ok: () => !/(pending|not observed - blocked before real-device capture)/i.test(evidence),
  },
  {
    name: "No BLOCKED run marker remains",
    ok: () => !/run status:\*\*\s*`?BLOCKED`?/i.test(evidence),
  },
  {
    name: "No raw WebSocket URLs are present",
    ok: () => !/wss?:\/\//i.test(evidence),
  },
  {
    name: "No local or absolute checkout paths are present",
    ok: () => !/(\/home\/coder\/|\/Users\/[^\s)]+|[A-Za-z]:\\\\[^\s)]+)/.test(evidence),
  },
  {
    name: "No forbidden diagnostic payload categories are present",
    ok: () => !/(cloneProof|terminal\s+text|terminal\s+transcript|helper\s+textarea\s+value|\btokens?\b|\bsecrets?\b)/i.test(evidence),
  },
];

let failed = 0;
for (const check of checks) {
  const ok = check.ok();
  console.log(`${ok ? "PASS" : "FAIL"} ${check.name}`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  console.error(`S02 mobile keyboard evidence acceptance failed: ${failed} check(s) failed.`);
  process.exit(1);
}

console.log("S02 mobile keyboard evidence accepted.");
