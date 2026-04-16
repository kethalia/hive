# S03: Scrollback Persistence Backend — UAT

**Milestone:** M006
**Written:** 2026-04-15T17:05:08.466Z

# S03 UAT: Scrollback Persistence Backend

## Preconditions
- Docker Compose stack running (`docker compose up -d`)
- Postgres healthy and accessible
- Terminal-proxy container has `DATABASE_URL` environment variable

## Test Case 1: Chunks Written to Postgres on Terminal Output
1. Open a terminal session via the browser UI
2. Run `echo "hello scrollback persistence"` in the terminal
3. Wait 6 seconds (flush interval is 5s)
4. Query Postgres: `SELECT reconnect_id, seq_num, byte_size, created_at FROM scrollback_chunks ORDER BY created_at DESC LIMIT 5`
5. **Expected**: At least one row with the session's reconnectId, seqNum starting at 0, byteSize > 0

## Test Case 2: SeqNum Ordering
1. In the same terminal session, run several commands generating output: `ls -la && date && whoami && env | head -20`
2. Wait 6 seconds for flush
3. Query: `SELECT seq_num, byte_size FROM scrollback_chunks WHERE reconnect_id = '<session-id>' ORDER BY seq_num ASC`
4. **Expected**: seqNum values are monotonically increasing (0, 1, 2, ...)

## Test Case 3: API Route Returns Ordered Binary Data
1. Copy the reconnectId from test case 1
2. `curl -s "http://localhost:3000/api/terminal/scrollback?reconnectId=<id>" -o /tmp/scrollback.bin`
3. `cat /tmp/scrollback.bin` — should contain recognizable terminal output
4. **Expected**: Binary data containing the terminal output from test cases 1-2, in chronological order

## Test Case 4: API Route Validation
1. `curl -s -w "%{http_code}" "http://localhost:3000/api/terminal/scrollback"` → **Expected**: 400
2. `curl -s -w "%{http_code}" "http://localhost:3000/api/terminal/scrollback?reconnectId=not-a-uuid"` → **Expected**: 400
3. `curl -s -w "%{http_code}" "http://localhost:3000/api/terminal/scrollback?reconnectId=00000000-0000-0000-0000-000000000000"` → **Expected**: 200 with empty body

## Test Case 5: Proxy Restart Preserves Scrollback
1. Generate terminal output and wait for flush (6s)
2. Note the reconnectId and check chunks exist in Postgres
3. Restart terminal-proxy: `docker compose restart terminal-proxy`
4. Query the API route with the old reconnectId
5. **Expected**: Previous scrollback data still returned — data survived proxy restart

## Test Case 6: Graceful Shutdown
1. With active terminal sessions generating output
2. `docker compose stop terminal-proxy` (sends SIGTERM)
3. Check terminal-proxy logs: `docker compose logs terminal-proxy | tail -20`
4. **Expected**: Logs show writer close messages for each active session, no data loss warnings

## Test Case 7: Degraded Mode Without DATABASE_URL
1. Remove DATABASE_URL from docker-compose.yml terminal-proxy environment
2. `docker compose up -d terminal-proxy`
3. Open a terminal session — it should work normally
4. Check logs: `docker compose logs terminal-proxy | grep scrollback`
5. **Expected**: Log message "DATABASE_URL not set — scrollback persistence disabled", terminal still functional

## Edge Cases
- **Large output**: Run `cat /dev/urandom | base64 | head -1000` to generate >100KB — should trigger immediate flush (100KB threshold)
- **Rapid reconnect**: Close and reopen browser quickly — new session should get new reconnectId, old scrollback still queryable
