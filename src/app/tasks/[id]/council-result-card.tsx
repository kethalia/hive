"use client";

import { useState } from "react";
import Link from "next/link";
import type { CouncilReport, AggregatedFinding } from "@/lib/council/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExternalLink } from "lucide-react";

/** Badge variant for council outcome. */
const outcomeVariant: Record<
  CouncilReport["outcome"],
  "default" | "secondary" | "destructive"
> = {
  complete: "default",
  partial: "secondary",
  inconclusive: "destructive",
};

/** Severity display config — emoji prefix and data-testid suffix. */
const SEVERITIES: Array<{
  key: AggregatedFinding["severity"];
  label: string;
  testId: string;
}> = [
  { key: "critical", label: "🔴 Critical", testId: "severity-critical" },
  { key: "major", label: "🟠 Major", testId: "severity-major" },
  { key: "minor", label: "🟡 Minor", testId: "severity-minor" },
  { key: "nit", label: "💬 Nit", testId: "severity-nit" },
];

const CONSENSUS_PREVIEW_COUNT = 3;

export function CouncilResultCard({ report }: { report: CouncilReport }) {
  const [expanded, setExpanded] = useState(false);

  // Count findings per severity
  const severityCounts = SEVERITIES.map(({ key }) => ({
    key,
    count: report.findings.filter((f) => f.severity === key).length,
  }));

  const visibleItems =
    expanded
      ? report.consensusItems
      : report.consensusItems.slice(0, CONSENSUS_PREVIEW_COUNT);

  const hasMore = report.consensusItems.length > CONSENSUS_PREVIEW_COUNT;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Council Review
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Outcome + severity count badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant={outcomeVariant[report.outcome] ?? "secondary"}
            data-testid="council-outcome-badge"
          >
            {report.outcome}
          </Badge>

          {severityCounts.map(({ key, count }) => {
            if (count === 0) return null;
            const cfg = SEVERITIES.find((s) => s.key === key)!;
            return (
              <Badge key={key} variant="outline" data-testid={cfg.testId}>
                {cfg.label} {count}
              </Badge>
            );
          })}
        </div>

        {/* Consensus items */}
        {report.consensusItems.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Consensus Items
            </p>
            <ul className="space-y-2">
              {visibleItems.map((item) => (
                <li
                  key={`${item.file}:${item.startLine}:${item.issue}`}
                  className="rounded-md border bg-muted/40 p-3 text-sm space-y-1"
                  data-testid="consensus-item"
                >
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-xs text-muted-foreground font-mono">
                      {item.file}:{item.startLine}
                    </code>
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      {item.agreementCount} agree
                    </Badge>
                  </div>
                  <p className="text-foreground">{item.issue}</p>
                  <p className="text-muted-foreground text-xs">
                    <span className="font-medium">Fix:</span> {item.fix}
                  </p>
                </li>
              ))}
            </ul>
            {hasMore && (
              <Button
                variant="ghost"
                size="sm"
                className="px-0 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded
                  ? "Show less"
                  : `Show ${report.consensusItems.length - CONSENSUS_PREVIEW_COUNT} more`}
              </Button>
            )}
          </div>
        )}

        {/* Footer: reviewer stats + PR comment link */}
        <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
          <span data-testid="reviewer-count">
            {report.reviewersCompleted}/{report.councilSize} reviewers completed
          </span>

          {report.postedCommentUrl && (
            <Link
              href={report.postedCommentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline text-sm"
              data-testid="pr-comment-link"
            >
              View PR comment
              <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
