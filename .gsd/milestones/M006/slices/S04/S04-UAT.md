# S04: Virtual Scrolling & Hydration UI — UAT

**Milestone:** M006
**Written:** 2026-04-15T17:39:29.513Z

# S04 UAT: Virtual Scrolling & Hydration UI

## Preconditions
- Hive dev server running (`tsx watch server.ts`)
- Postgres running with scrollback data from a terminal session (S03 must be working)
- A workspace with an active terminal that has generated scrollback (e.g., ran `seq 1 5000` or similar)
- Browser with DevTools console open

## Test Case 1: Scrollback Hydration on Reconnect

**Steps:**
1. Open a workspace terminal in Hive dashboard
2. Run `seq 1 200` to generate visible output
3. Close the browser tab completely
4. Reopen the terminal page for the same workspace

**Expected:**
- Console shows: `[hydration] idle → loading` then `[hydration] loading → hydrated`
- Terminal displays the previous output (seq numbers) before any new live output appears
- No flash of empty terminal followed by history appearing
- "Restoring history..." banner briefly visible during fetch

## Test Case 2: Hydration Error Handling

**Steps:**
1. Open a workspace terminal
2. In DevTools, block requests matching `/api/terminal/scrollback` (Network tab → block URL)
3. Refresh the page or trigger a reconnect

**Expected:**
- Console shows: `[hydration] idle → loading` then warning with reconnectId
- "History unavailable" banner appears in terminal UI
- Live terminal still works — user can type and see output
- Banner does not block terminal interaction

## Test Case 3: Live Data Gating During Hydration

**Steps:**
1. Open a workspace terminal
2. In another terminal/tab, run a command that produces continuous output in the same session (e.g., `while true; do date; sleep 0.1; done`)
3. Refresh the browser tab

**Expected:**
- Hydrated history appears first (older output)
- Live output from the continuous command appears after hydration completes
- No interleaving of old and new data — clean boundary between hydrated content and live stream

## Test Case 4: History Panel Activation

**Steps:**
1. Open a workspace terminal with substantial scrollback (run `seq 1 5000`)
2. Scroll up in xterm until you reach the very top of xterm's buffer (viewportY = 0)

**Expected:**
- History panel smoothly expands above the xterm container (CSS transition, no pop-in)
- Panel shows older chunks with ANSI colors preserved (if output had colors)
- Loading indicator (skeleton rows) visible briefly while chunks load
- Font and background color match xterm's appearance

## Test Case 5: Lazy Loading Older Chunks

**Steps:**
1. With the history panel open (from Test Case 4), scroll to the top of the history panel

**Expected:**
- Loading skeletons (pulsing gray bars) appear at top while older chunks load
- New older content appears above the current content
- Repeat scrolling to top loads progressively older chunks
- When no more chunks exist, "No older history available" message shown

## Test Case 6: Jump-to-Bottom Button

**Steps:**
1. Open a terminal with scrollback, scroll up to activate the history panel
2. Observe the floating button at bottom-right with a down-arrow icon

**Expected:**
- Button fades in when scrolled away from live output
- Clicking the button: history panel smoothly collapses, xterm scrolls to bottom (live output)
- Button fades out when at the bottom of live output
- Button also appears when scrolled up within xterm (not just in history panel)

## Test Case 7: Pagination API Direct Test

**Steps:**
1. Open DevTools Network tab
2. Make a direct API call: `fetch('/api/terminal/scrollback?reconnectId=<id>&cursor=9999&limit=10').then(r => r.json()).then(console.log)`

**Expected:**
- Response is JSON with `{ chunks: [...], totalChunks: N }` 
- Each chunk has `seqNum` and `data` (base64) fields
- `X-Total-Chunks` header present in response
- Changing cursor value pages through different chunks

## Test Case 8: Backward Compatibility

**Steps:**
1. Call the API without pagination params: `fetch('/api/terminal/scrollback?reconnectId=<id>')`

**Expected:**
- Response is binary (application/octet-stream), not JSON
- Contains all chunks concatenated in ascending order
- `X-Total-Chunks` header still present
- This matches S03's original API contract

## Edge Cases

- **No scrollback data:** Terminal with no history → hydration completes instantly with no write, history panel shows empty state
- **Single chunk:** Only one chunk in Postgres → hydration writes it, history panel shows it, "No older history" on scroll-up
- **Rapid tab switching:** Switch between terminal tabs quickly → each tab hydrates independently, no cross-tab data bleed
- **Browser resize during history panel open:** Panel and xterm should both re-layout correctly via ResizeObserver
