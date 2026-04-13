# S03: Templates Dashboard Page with xterm.js — UAT

**Milestone:** M004
**Written:** 2026-04-13T23:22:15.939Z

# S03 UAT: Templates Dashboard Page with xterm.js

## Preconditions
- Hive orchestrator running (`docker-compose up`)
- Coder instance accessible with valid CODER_URL and CODER_SESSION_TOKEN
- At least one template (ai-dev or hive) exists in Coder
- Redis and BullMQ worker running for push queue processing

## Test Case 1: Page Load and Status Display
1. Navigate to `/templates` in the browser
2. **Expected:** Page loads with a table showing template rows
3. **Expected:** Each row displays: Name, Last Pushed date, Status badge (green "Current" or amber "Stale"), and a Push button
4. **Expected:** Templates nav link visible in the left sidebar with LayoutTemplate icon

## Test Case 2: Status Badge Accuracy
1. Modify a local template file (e.g., edit `templates/ai-dev/main.tf`)
2. Refresh `/templates` page
3. **Expected:** The modified template shows an amber "Stale" badge
4. Revert the change and refresh
5. **Expected:** Badge returns to green "Current"

## Test Case 3: Push Flow with xterm.js Terminal
1. Ensure at least one template is Stale
2. Click the "Push" button on the stale template row
3. **Expected:** Button shows a spinner and becomes disabled
4. **Expected:** An inline terminal panel appears below the row with dark background
5. **Expected:** Terminal streams live coder push output with ANSI color rendering
6. **Expected:** On completion, a success (green) or failure (red) indicator appears
7. **Expected:** Terminal panel has a close button to dismiss it

## Test Case 4: Badge Refresh After Successful Push
1. Complete a successful push (Test Case 3)
2. **Expected:** The template's status badge automatically flips from "Stale" to "Current"
3. **Expected:** The Push button re-enables

## Test Case 5: Polling Refresh
1. Open `/templates` in the browser
2. Wait 30+ seconds without interaction
3. **Expected:** Status badges refresh automatically (visible if another user pushes a template)

## Test Case 6: Error Handling
1. Stop the BullMQ worker process
2. Click Push on a template
3. **Expected:** Push attempt fails gracefully with an error indicator, not a crash
4. **Expected:** Page remains functional after the error

## Test Case 7: Multiple Concurrent Pushes
1. Click Push on template A
2. While A is pushing, click Push on template B
3. **Expected:** Both terminals stream independently
4. **Expected:** Each push completes and updates its own badge

## Edge Cases
- **No templates configured:** Page should render empty table or informational message
- **Network timeout on status poll:** Page should continue functioning, poll retries on next interval
- **SSE connection drops mid-push:** Terminal should show connection loss, not hang indefinitely
