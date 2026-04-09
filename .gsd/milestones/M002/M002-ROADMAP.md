# M002: Council Review

## Vision
After a task produces a PR, N independent Claude reviewer agents analyse the diff in parallel inside isolated Coder workspaces, emit structured findings (file, line, severity, issue, fix, reasoning), and the orchestrator aggregates by consensus (≥2 agreement) and posts a single combined review comment to the GitHub PR. The dashboard shows a CouncilResultCard with finding counts by severity and highlighted consensus items.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | S01 | high | — | ✅ | terraform validate passes for hive-council template; prisma migrate adds councilSize + councilReport columns; BullMQ workers for both council queues register and accept test jobs; existing pipeline tests still pass with verifier as awaitable step 9. |
| S02 | S02 | high | — | ✅ | Unit tests show council blueprint steps execute correctly — claude --print invoked with diff, valid JSON returned as ReviewerFinding[], invalid JSON fails the job, empty diff produces empty findings gracefully. |
| S03 | S03 | medium | — | ✅ | Given 3 mock reviewer outputs with overlapping findings at the same file+line, aggregation correctly populates consensusItems; formatted Markdown comment body includes severity sections; task.councilReport has all required fields. |
| S04 | S04 | low | — | ✅ | Task detail page shows CouncilResultCard after VerificationReportCard, with severity badge counts (critical/major/minor/nit) and highlighted consensus items. Task submission form has a council size numeric field (default 3, 1-7). |
