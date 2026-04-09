/**
 * Formatter — renders a CouncilReport into a markdown PR comment string.
 *
 * Pure function: no I/O, no side effects.
 */

import type { AggregatedFinding, CouncilReport } from "./types.js";

type Severity = AggregatedFinding["severity"];

const SEVERITY_ORDER: Severity[] = ["critical", "major", "minor", "nit"];

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  nit: "💬",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
  nit: "Nit",
};

/**
 * Format a CouncilReport into a markdown string suitable for a GitHub PR comment.
 *
 * Severity sections are emitted only when that severity has at least one consensus
 * finding. Sections are ordered critical → major → minor → nit.
 */
export function formatCouncilComment(report: CouncilReport): string {
  const { consensusItems, findings, reviewersCompleted, councilSize } = report;

  if (consensusItems.length === 0) {
    return [
      "## 🤝 Council Review",
      "",
      "✅ **No consensus issues found.**",
      "",
      `> ${reviewersCompleted} of ${councilSize} reviewers completed · ${findings.length} total finding(s) · 0 consensus`,
    ].join("\n");
  }

  // Group by severity
  const bySeverity = new Map<Severity, AggregatedFinding[]>();
  for (const item of consensusItems) {
    const list = bySeverity.get(item.severity) ?? [];
    list.push(item);
    bySeverity.set(item.severity, list);
  }

  const lines: string[] = ["## 🤝 Council Review", ""];

  for (const severity of SEVERITY_ORDER) {
    const items = bySeverity.get(severity);
    if (!items || items.length === 0) continue;

    const emoji = SEVERITY_EMOJI[severity];
    const label = SEVERITY_LABEL[severity];
    lines.push(`### ${emoji} ${label}`);
    lines.push("");

    for (const item of items) {
      lines.push(`**\`${item.file}:${item.startLine}\`** (agreed by ${item.agreementCount} reviewers)`);
      lines.push("");
      lines.push(`- **Issue:** ${item.issue}`);
      lines.push(`- **Fix:** ${item.fix}`);
      lines.push(`- **Reasoning:** ${item.reasoning}`);
      lines.push("");
    }
  }

  // Footer summary
  lines.push("---");
  lines.push(
    `> ${findings.length} total finding(s) · ${consensusItems.length} consensus · ${reviewersCompleted} of ${councilSize} reviewers completed`,
  );

  return lines.join("\n");
}
