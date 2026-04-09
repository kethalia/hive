# S04: S04: Council Dashboard — UAT

**Milestone:** M002
**Written:** 2026-04-09T12:11:01.186Z

# S04 User Acceptance Test (UAT)

## Preconditions
- Codebase at slice S04 completion (all tests pass, councilSize field added, CouncilResultCard component integrated)
- Database with task records containing valid `councilReport` JSON (created by S03 aggregation step)
- Task detail page route `/tasks/[id]` renders with VerificationReportCard already present

## Test Cases

### T01: CouncilResultCard Rendering

#### TC-T01-01: Outcome Badge Renders Correctly
**Given:** A task with `councilReport.outcome = "complete"`
**When:** User navigates to task detail page
**Then:** CouncilResultCard appears after VerificationReportCard; Outcome badge displays "Complete" with default variant

#### TC-T01-02: Severity Count Badges Render Only When Count > 0
**Given:** A task with 2 critical, 3 major, 0 minor, 1 nit finding
**When:** User views task detail page
**Then:** Badges "🔴 2 Critical", "🟠 3 Major", "💬 1 Nit" render; "🟡 Minor" does NOT render

#### TC-T01-03: Consensus Items List Renders with File:Line and Issue Text
**Given:** A task with `consensusItems` containing file, startLine, issue, fix, agreementCount
**When:** User views task detail page
**Then:** Each item displays "file:line" (e.g. "src/lib/foo.ts:42"), issue text, fix text, and agreement count

#### TC-T01-04: Expansion Toggle for Consensus Items > 3
**Given:** A task with `consensusItems.length = 5`
**When:** User views task detail page
**Then:** First 3 items visible; "Show more" button appears; clicking expands to all 5; clicking "Show less" collapses back

#### TC-T01-05: Reviewer Completion Footer
**Given:** A task with `reviewersCompleted = 2` and `councilSize = 3`
**When:** User views task detail page
**Then:** Footer displays "2/3 reviewers completed"

#### TC-T01-06: PR Comment Link Renders When postedCommentUrl is Set
**Given:** A task with `postedCommentUrl = "https://github.com/owner/repo/pull/42#issuecomment-123"`
**When:** User views task detail page
**Then:** Footer includes "View on GitHub" link to that URL

#### TC-T01-07: Empty Findings Graceful Handling
**Given:** A task with `consensusItems = []` (empty array)
**When:** User views task detail page
**Then:** CouncilResultCard still renders; no severity badges appear; no errors

### T02: councilSize Form Field

#### TC-T02-01: Form Field Renders with Default Value
**Given:** User navigates to `/tasks/new`
**When:** Page loads
**Then:** Numeric input "Council Size" is visible with default=3, min=1, max=7

#### TC-T02-02: Form Validation: Rejects Values Outside 1-7
**Given:** User on task creation form
**When:** User types "0" and submits
**Then:** Validation fails, task NOT created
**Variants:** Input "8" rejected; input "1" accepted; input "7" accepted

#### TC-T02-03: Default councilSize (3) Applied If Field Left Empty
**Given:** User on task creation form
**When:** User leaves councilSize field empty and submits
**Then:** Task created with `councilSize = 3`

#### TC-T02-04: councilSize Persists to Database
**Given:** User creates task with `councilSize = 5`
**When:** Task saved to database
**Then:** Task row has `councilSize = 5`; detail page shows "X/5 reviewers completed"

#### TC-T02-05: councilSize Coercion from String to Number
**Given:** Form submits `councilSize = "5"` (string)
**When:** Schema parses
**Then:** Zod coercion converts to number 5; no errors

### Integration: End-to-End

#### TC-Integration-01: Create Task with Custom councilSize, Verify on Detail Page
**Given:** User on task creation form
**When:** User fills form with councilSize=4 and submits
**Then:** Task created; council worker processes; detail page shows CouncilResultCard with "4/4 reviewers completed" and severity badges/consensus items

## Success Criteria
✅ All T01 rendering tests pass
✅ All T02 form field tests pass
✅ No regression: 268 tests pass
✅ TypeScript: ≤23 errors (all pre-existing)
✅ E2E: Form → DB → detail page works end-to-end
