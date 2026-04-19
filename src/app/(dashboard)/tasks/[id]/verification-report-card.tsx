"use client";

import { useState } from "react";
import type { VerificationReport } from "@/lib/verification/types";
import { outcomeVariant, formatDuration, formatTimestamp } from "@/lib/helpers/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Clock, FlaskConical } from "lucide-react";

export function VerificationReportCard({ report }: { report: VerificationReport }) {
  const [logsExpanded, setLogsExpanded] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Verification Report
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Strategy + Outcome badges */}
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant="outline" data-testid="strategy-badge">
            <FlaskConical className="mr-1 h-3 w-3" />
            {report.strategy}
          </Badge>
          <Badge
            variant={outcomeVariant[report.outcome] ?? "secondary"}
            data-testid="outcome-badge"
          >
            {report.outcome}
          </Badge>
        </div>

        {/* Duration + Timestamp */}
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1" data-testid="duration">
            <Clock className="h-3 w-3" />
            Duration: {formatDuration(report.durationMs)}
          </span>
          <span data-testid="timestamp">
            {formatTimestamp(report.timestamp)}
          </span>
        </div>

        {/* Collapsible logs */}
        {report.logs && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="px-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setLogsExpanded(!logsExpanded)}
              data-testid="logs-toggle"
            >
              {logsExpanded ? (
                <ChevronDown className="mr-1 h-3 w-3" />
              ) : (
                <ChevronRight className="mr-1 h-3 w-3" />
              )}
              {logsExpanded ? "Hide logs" : "Show logs"}
            </Button>
            {logsExpanded && (
              <pre
                className="mt-2 max-h-[400px] overflow-auto rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap"
                data-testid="logs-content"
              >
                {report.logs}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
