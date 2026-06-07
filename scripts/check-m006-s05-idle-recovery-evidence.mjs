#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const evidencePath = "docs/m006-s05-idle-recovery-evidence.md";

const requiredFields = [
  "Run status",
  "Environment class",
  "Deployment or production-like preflight",
  "Coder workspace availability",
  "Disconnect method",
  "Blast-radius approval state",
  "Reload-sentinel result",
  "Recovery UI observations",
  "Terminal or Git pane identity preservation",
  "Post-recovery input usability",
  "Resize/refit signal",
  "Sanitized keepalive/proxy status before",
  "Sanitized keepalive/proxy status after",
  "Old refresh-page failure absence",
  "Final acceptance",
];

const usage = `Usage: node ${basename(process.argv[1] ?? "check-m006-s05-idle-recovery-evidence.mjs")} [--allow-pending|--preflight|--self-test|--help]\n\nChecks docs/m006-s05-idle-recovery-evidence.md for required sanitized idle-recovery evidence.\n  --allow-pending  Accept the template state while still rejecting forbidden data.\n  --preflight      Accept a sanitized preflight baseline or blocked prerequisite record.\n  --self-test      Run built-in negative and positive checker fixtures.\n  --help           Print this usage text.\n`;

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(usage);
  process.exit(0);
}
const allowedArgs = new Set(["--allow-pending", "--preflight", "--self-test"]);
const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length > 0 || args.length > 1) {
  process.stderr.write(usage);
  process.exit(2);
}

const allowPending = args.includes("--allow-pending");
const preflight = args.includes("--preflight");
const selfTest = args.includes("--self-test");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectFields(markdown) {
  const fields = new Map();
  for (const label of requiredFields) {
    const escaped = escapeRegExp(label);
    const match = markdown.match(
      new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*` + "`([^`]*)`\\s*$", "m"),
    );
    fields.set(label, match?.[1]?.trim() ?? "");
  }
  return fields;
}

function isPendingOrBlocked(value) {
  return /\b(?:pending|blocked|todo|tbd|unknown|not captured|not observed|not available)\b/i.test(
    value,
  );
}

function isYes(value) {
  return /^(?:yes|accepted|pass(?:ed)?|available|approved|preserved|unchanged|same|healthy|connected|absent|no\b|n\/a\b)/i.test(
    value.trim(),
  );
}

function containsUsefulSignal(value) {
  const normalized = value.toLowerCase();
  return (
    isYes(value) ||
    /\b(?:deployed|preview|production-like|prod-like|rollout|runtime|proxy|coder|workspace|idle|restart|network|disconnect|reconnect|recovered|connected|same|input|resize|refit|redacted|sanitized|category|count|healthy|absent|accepted)\b/.test(
      normalized,
    )
  );
}

const forbiddenPatterns = [
  {
    name: "No raw WebSocket URLs are present",
    regex: /\bwss?:\/\//i,
  },
  {
    name: "No full HTTP URLs are present",
    regex: /\bhttps?:\/\//i,
  },
  {
    name: "No clone proof, token, cookie, credential, or secret payload keys are present",
    regex:
      /\b(?:cloneProof|clone-proof|proof|token|access_token|refresh_token|secret|credential|password|cookie|set-cookie|authorization)\b\s*[:=]/i,
  },
  {
    name: "No bearer/basic authorization material is present",
    regex: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/,
  },
  {
    name: "No terminal transcripts or command-output markers are present",
    regex:
      /\b(?:terminal transcript|terminal scrollback|command output|stdout|stderr|shell output|prompt\$|\$\s+(?:kubectl|curl|pnpm|npm|node|tmux|git)\b)/i,
  },
  {
    name: "No absolute POSIX paths are present",
    regex:
      /(^|[\s`'"(=])\/(?!keepalive\/status\b|runtime-config\.js\b)(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/m,
  },
  {
    name: "No absolute Windows paths are present",
    regex: /\b[A-Za-z]:\\\\[^\s`'")]+/,
  },
  {
    name: "No UUID-like raw workspace identifiers are present",
    regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  },
  {
    name: "No raw session-name parameters or keys are present",
    regex:
      /\b(?:sessionName|session_name|rawSessionName|raw-session-name|session)\b\s*[=:]\s*[A-Za-z0-9._:-]{3,}/i,
  },
  {
    name: "No raw proxy error payloads are present",
    regex:
      /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|upstream error|proxy error|WebSocket error|CloseEvent)\b\s*[:=]/i,
  },
  {
    name: "No unredacted keepalive workspace keys are present",
    regex:
      /(?:\/keepalive\/status|keepalive[^\n]{0,40})[\s\S]{0,400}"(?!status"|category"|activeConnectionCount"|connectionCount"|lastSeenAt"|updatedAt"|checkedAt"|redacted-workspace-key"|workspace-key-redacted")[^"\n]{8,}"\s*:\s*\{/i,
  },
];

const preflightFieldLabels = [
  "Run status",
  "Environment class",
  "Deployment or production-like preflight",
  "Coder workspace availability",
  "Disconnect method",
  "Blast-radius approval state",
  "Sanitized keepalive/proxy status before",
];

function isPendingPlaceholder(value) {
  return /\b(?:pending|todo|tbd|not captured|not observed)\b/i.test(value);
}

const preflightChecks = [
  {
    name: "Run status records preflight outcome or blocked prerequisite state",
    ok: (fields) =>
      /^(?:preflight|blocked|accepted|pass(?:ed)?|validated)\b/i.test(
        fields.get("Run status") ?? "",
      ),
  },
  {
    name: "Preflight target fields are no longer pending placeholders",
    ok: (fields) =>
      preflightFieldLabels.every((label) => !isPendingPlaceholder(fields.get(label) ?? "")),
  },
  {
    name: "Environment class is production-like or explicitly blocked",
    ok: (fields) =>
      /\b(?:deployed|preview|production-like|prod-like|local|blocked|missing|unavailable)\b/i.test(
        fields.get("Environment class") ?? "",
      ),
  },
  {
    name: "Deployment or production-like preflight records a sanitized signal",
    ok: (fields) =>
      /\b(?:passed|healthy|reachable|blocked|missing|unreachable|unavailable|unauthenticated|no acceptable|not started)\b/i.test(
        fields.get("Deployment or production-like preflight") ?? "",
      ),
  },
  {
    name: "Coder workspace availability records a sanitized signal",
    ok: (fields) =>
      /\b(?:available|running|reachable|blocked|missing|unreachable|authenticated|unauthenticated|readable)\b/i.test(
        fields.get("Coder workspace availability") ?? "",
      ),
  },
  {
    name: "Disconnect method is chosen, deferred, or blocked",
    ok: (fields) =>
      /\b(?:idle|restart|network drop|disconnect|browser network drop|deferred|blocked|not selected)\b/i.test(
        fields.get("Disconnect method") ?? "",
      ),
  },
  {
    name: "Blast-radius approval state avoids unsafe shared production disruption",
    ok: (fields) =>
      /\b(?:approved|preview|non-shared|isolated|local|not required|n\/a|avoided|forbidden|blocked|no restart)\b/i.test(
        fields.get("Blast-radius approval state") ?? "",
      ),
  },
  {
    name: "Sanitized keepalive/proxy status before records status without identifiers",
    ok: (fields) =>
      /\b(?:redacted|sanitized|category|count|healthy|active|empty|status|blocked|unreachable|missing|malformed)\b/i.test(
        fields.get("Sanitized keepalive/proxy status before") ?? "",
      ),
  },
];

const finalChecks = [
  {
    name: "Run status is accepted, not pending or blocked",
    ok: (fields) =>
      /^(?:accepted|pass(?:ed)?|complete|validated)\b/i.test(fields.get("Run status") ?? ""),
  },
  {
    name: "Environment class is deployed or production-like",
    ok: (fields) =>
      /\b(?:deployed|preview|production-like|prod-like|production)\b/i.test(
        fields.get("Environment class") ?? "",
      ),
  },
  {
    name: "Deployment or production-like preflight has a positive result",
    ok: (fields) => isYes(fields.get("Deployment or production-like preflight") ?? ""),
  },
  {
    name: "Coder workspace availability is confirmed",
    ok: (fields) => isYes(fields.get("Coder workspace availability") ?? ""),
  },
  {
    name: "Disconnect method is an accepted transient disconnect",
    ok: (fields) =>
      /\b(?:idle|restart|restarted|network drop|disconnect|dropped|proxy|pod|rollout)\b/i.test(
        fields.get("Disconnect method") ?? "",
      ),
  },
  {
    name: "Blast-radius approval state is safe or approved",
    ok: (fields) =>
      /\b(?:approved|preview|non-shared|isolated|local|not required|n\/a)\b/i.test(
        fields.get("Blast-radius approval state") ?? "",
      ),
  },
  {
    name: "Reload sentinel is preserved",
    ok: (fields) =>
      /\b(?:preserved|unchanged|same|no reload|no page refresh)\b/i.test(
        fields.get("Reload-sentinel result") ?? "",
      ),
  },
  {
    name: "Recovery UI observations show in-place recovery",
    ok: (fields) =>
      /\b(?:recovered|reconnected|connected|recovery|healthy|cleared)\b/i.test(
        fields.get("Recovery UI observations") ?? "",
      ),
  },
  {
    name: "Terminal or Git pane identity preservation is confirmed",
    ok: (fields) =>
      /\b(?:preserved|same|unchanged|identity|mounted|pane)\b/i.test(
        fields.get("Terminal or Git pane identity preservation") ?? "",
      ),
  },
  {
    name: "Post-recovery input usability is confirmed",
    ok: (fields) =>
      /\b(?:accepted|usable|input|typed|received|interactive|confirmed|yes)\b/i.test(
        fields.get("Post-recovery input usability") ?? "",
      ),
  },
  {
    name: "Resize/refit signal is present or Git-only N/A is stated",
    ok: (fields) =>
      /\b(?:resize|refit|rows|cols|dimensions|n\/a|git-only|not terminal)\b/i.test(
        fields.get("Resize/refit signal") ?? "",
      ),
  },
  {
    name: "Sanitized keepalive/proxy status before has redacted runtime signal",
    ok: (fields) => {
      const value = fields.get("Sanitized keepalive/proxy status before") ?? "";
      return /\b(?:redacted|sanitized|category|count|healthy|active|empty|status)\b/i.test(value);
    },
  },
  {
    name: "Sanitized keepalive/proxy status after has redacted runtime signal",
    ok: (fields) => {
      const value = fields.get("Sanitized keepalive/proxy status after") ?? "";
      return /\b(?:redacted|sanitized|category|count|healthy|active|connected|status)\b/i.test(
        value,
      );
    },
  },
  {
    name: "Old refresh-page failure is absent",
    ok: (fields, markdown) =>
      /\b(?:absent|not observed|no old refresh-page failure|no refresh-page failure|yes)\b/i.test(
        fields.get("Old refresh-page failure absence") ?? "",
      ) &&
      !/Connection failed after multiple attempts\. Refresh the page to try again\./i.test(
        markdown,
      ),
  },
  {
    name: "Final acceptance is recorded",
    ok: (fields) =>
      /\b(?:accepted|pass(?:ed)?|validated|approved|yes)\b/i.test(
        fields.get("Final acceptance") ?? "",
      ),
  },
];

function evaluate(markdown, { allowPending = false, preflight = false } = {}) {
  const results = [];
  const fields = collectFields(markdown);

  for (const label of requiredFields) {
    const value = fields.get(label) ?? "";
    results.push({
      name: `Required field is present: ${label}`,
      ok: Boolean(value),
    });
  }

  for (const pattern of forbiddenPatterns) {
    results.push({
      name: pattern.name,
      ok: !pattern.regex.test(markdown),
    });
  }

  if (preflight) {
    for (const check of preflightChecks) {
      results.push({
        name: check.name,
        ok: check.ok(fields, markdown),
      });
    }
    return results;
  }

  if (!allowPending) {
    results.push({
      name: "No pending, blocked, placeholder, or unavailable field values remain",
      ok: [...fields.values()].every((value) => value && !isPendingOrBlocked(value)),
    });

    for (const [label, value] of fields.entries()) {
      results.push({
        name: `Final field has operational signal: ${label}`,
        ok: Boolean(value) && containsUsefulSignal(value),
      });
    }

    for (const check of finalChecks) {
      results.push({
        name: check.name,
        ok: check.ok(fields, markdown),
      });
    }
  }

  return results;
}

function summarize(results, label) {
  let failed = 0;
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}`);
    if (!result.ok) failed += 1;
  }
  if (failed > 0) {
    console.error(`${label} failed: ${failed} check(s) failed.`);
    return false;
  }
  console.log(`${label} accepted.`);
  return true;
}

function buildFixture(overrides = {}) {
  const values = new Map([
    ["Run status", "ACCEPTED - recovery run validated"],
    ["Environment class", "preview deployed environment"],
    ["Deployment or production-like preflight", "passed rollout/runtime/proxy preflight"],
    ["Coder workspace availability", "available before and after disconnect"],
    ["Disconnect method", "terminal proxy restart in isolated preview"],
    ["Blast-radius approval state", "not required - isolated preview target"],
    ["Reload-sentinel result", "preserved unchanged; no page refresh"],
    ["Recovery UI observations", "recovery state appeared and returned connected"],
    ["Terminal or Git pane identity preservation", "same mounted pane identity preserved"],
    ["Post-recovery input usability", "input accepted after recovery"],
    ["Resize/refit signal", "terminal refit/resize signal observed after reconnect"],
    [
      "Sanitized keepalive/proxy status before",
      "sanitized status category/count summary with redacted workspace key",
    ],
    [
      "Sanitized keepalive/proxy status after",
      "sanitized connected status category/count summary with redacted workspace key",
    ],
    ["Old refresh-page failure absence", "absent"],
    ["Final acceptance", "accepted"],
  ]);

  for (const [label, value] of Object.entries(overrides)) {
    values.set(label, value);
  }

  return `# Fixture\n\n## Required fields\n\n${requiredFields
    .map((label) => `- **${label}:** \`${values.get(label)}\``)
    .join("\n")}\n`;
}

function buildPreflightFixture(overrides = {}) {
  return buildFixture({
    "Run status": "PREFLIGHT - accepted baseline captured",
    "Environment class": "production-like local target with real Coder connectivity",
    "Deployment or production-like preflight":
      "reachable proxy health and runtime preflight passed",
    "Coder workspace availability": "authenticated Coder workspace running; workspace key redacted",
    "Disconnect method": "browser network drop selected",
    "Blast-radius approval state":
      "not required - local non-shared target; shared production restart avoided",
    "Sanitized keepalive/proxy status before":
      "sanitized status count summary with redacted workspace key",
    "Reload-sentinel result": "PENDING - T03 recovery run not captured yet",
    "Recovery UI observations": "PENDING - T03 recovery run not captured yet",
    "Terminal or Git pane identity preservation": "PENDING - T03 recovery run not captured yet",
    "Post-recovery input usability": "PENDING - T03 recovery run not captured yet",
    "Resize/refit signal": "PENDING - T03 recovery run not captured yet",
    "Sanitized keepalive/proxy status after": "PENDING - T03 recovery run not captured yet",
    "Old refresh-page failure absence": "PENDING - T03 recovery run not captured yet",
    "Final acceptance": "PENDING - T03 recovery run not captured yet",
    ...overrides,
  });
}

function expectFixture(name, markdown, options, expectedPass) {
  const passed = evaluate(markdown, options).every((result) => result.ok);
  if (passed !== expectedPass) {
    console.error(
      `FAIL self-test ${name}: expected ${expectedPass ? "pass" : "fail"}, got ${passed ? "pass" : "fail"}`,
    );
    return false;
  }
  console.log(`PASS self-test ${name}`);
  return true;
}

function runSelfTest() {
  const fixtures = [
    ["valid final fixture", buildFixture(), {}, true],
    [
      "valid preflight fixture with pending recovery fields passes preflight mode",
      buildPreflightFixture(),
      { preflight: true },
      true,
    ],
    [
      "blocked preflight fixture passes preflight mode",
      buildPreflightFixture({
        "Run status": "BLOCKED - preflight prerequisites missing",
        "Environment class":
          "blocked because no acceptable deployed or production-like target is available",
        "Deployment or production-like preflight":
          "blocked because proxy health is unreachable and Kubernetes is missing",
        "Coder workspace availability":
          "authenticated Coder workspace list readable; running count summarized with identifiers redacted",
        "Disconnect method": "blocked - no safe disconnect target selected",
        "Blast-radius approval state": "shared production restart avoided; no approval present",
        "Sanitized keepalive/proxy status before":
          "blocked - keepalive status unreachable before disconnect",
      }),
      { preflight: true },
      true,
    ],
    [
      "pending production-like target field fails preflight mode",
      buildPreflightFixture({ "Environment class": "PENDING - target not selected" }),
      { preflight: true },
      false,
    ],
    [
      "full HTTP URL fails preflight mode",
      buildPreflightFixture({
        "Deployment or production-like preflight": "passed at https://hive.example.invalid",
      }),
      { preflight: true },
      false,
    ],
    [
      "absolute POSIX path fails preflight mode",
      buildPreflightFixture({
        "Coder workspace availability": "available at /home/coder/projects/kethalia/hive",
      }),
      { preflight: true },
      false,
    ],
    [
      "UUID-like workspace ID fails preflight mode",
      buildPreflightFixture({
        "Coder workspace availability": "workspace 123e4567-e89b-12d3-a456-426614174000 running",
      }),
      { preflight: true },
      false,
    ],
    [
      "pending run status fails final mode",
      buildFixture({ "Run status": "PENDING - not run" }),
      {},
      false,
    ],
    [
      "pending run status passes pending mode",
      buildFixture({ "Run status": "PENDING - not run" }),
      { allowPending: true },
      true,
    ],
    [
      "raw WebSocket URL fails pending mode",
      buildFixture({
        "Recovery UI observations": "saw wss://terminal.example.invalid/ws reconnect",
      }),
      { allowPending: true },
      false,
    ],
    [
      "full HTTP URL fails pending mode",
      buildFixture({
        "Deployment or production-like preflight": "passed at https://hive.example.invalid",
      }),
      { allowPending: true },
      false,
    ],
    [
      "absolute POSIX path fails pending mode",
      buildFixture({
        "Coder workspace availability": "available at /home/coder/projects/kethalia/hive",
      }),
      { allowPending: true },
      false,
    ],
    [
      "absolute Windows path fails pending mode",
      buildFixture({ "Coder workspace availability": "available at C:\\\\Users\\\\coder\\\\repo" }),
      { allowPending: true },
      false,
    ],
    [
      "UUID-like workspace ID fails pending mode",
      buildFixture({
        "Coder workspace availability": "workspace 123e4567-e89b-12d3-a456-426614174000 available",
      }),
      { allowPending: true },
      false,
    ],
    [
      "token key fails pending mode",
      buildFixture({ "Recovery UI observations": "token=abc123secret" }),
      { allowPending: true },
      false,
    ],
    [
      "clone proof key fails pending mode",
      buildFixture({ "Terminal or Git pane identity preservation": "cloneProof=abc123" }),
      { allowPending: true },
      false,
    ],
    [
      "terminal transcript marker fails pending mode",
      buildFixture({ "Post-recovery input usability": "terminal transcript shows prompt$ pwd" }),
      { allowPending: true },
      false,
    ],
    [
      "raw session name key fails pending mode",
      buildFixture({ "Terminal or Git pane identity preservation": "sessionName=git-clone-raw" }),
      { allowPending: true },
      false,
    ],
    [
      "raw proxy error fails pending mode",
      buildFixture({ "Recovery UI observations": "proxy error: ECONNRESET" }),
      { allowPending: true },
      false,
    ],
    [
      "unredacted keepalive workspace key fails pending mode",
      buildFixture({
        "Sanitized keepalive/proxy status after":
          '/keepalive/status {"workspace-raw-key":{"status":"active"}}',
      }),
      { allowPending: true },
      false,
    ],
  ];

  const allPassed = fixtures.every(([name, markdown, options, expectedPass]) =>
    expectFixture(name, markdown, options, expectedPass),
  );
  if (!allPassed) process.exit(1);
  console.log("M006 S05 evidence checker self-test accepted.");
}

if (selfTest) {
  runSelfTest();
  process.exit(0);
}

let evidence;
try {
  evidence = readFileSync(evidencePath, "utf8");
} catch (error) {
  console.error(`FAIL evidence artifact is readable: ${error.message}`);
  process.exit(1);
}

const results = evaluate(evidence, { allowPending, preflight });
const passed = summarize(
  results,
  preflight
    ? "M006 S05 preflight evidence"
    : allowPending
      ? "M006 S05 pending evidence contract"
      : "M006 S05 final evidence",
);
process.exit(passed ? 0 : 1);
