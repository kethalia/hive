# S02: Per-User Token Rewiring — UAT

**Milestone:** M010
**Written:** 2026-04-18T20:42:25.054Z

## UAT Script: Per-User Token Rewiring

### Preconditions
- M010 S01 complete (User/CoderToken/Session tables exist, login flow works)
- Two test users with valid Coder credentials on different deployments
- ENCRYPTION_KEY env var set (32-byte hex)
- No CODER_URL or CODER_SESSION_TOKEN in .env

### Test Case 1: Task Submission Uses Submitting User's Token
1. Log in as User A (Coder deployment at https://coder-a.example.com)
2. Submit a task via the dashboard
3. **Expected:** Task record has userId = User A's ID
4. **Expected:** BullMQ job data includes userId = User A's ID
5. **Expected:** Worker resolves User A's CoderToken, decrypts it, creates workspace on coder-a.example.com
6. **Expected:** Council reviewers also use User A's token

### Test Case 2: Multi-User Isolation
1. Log in as User A, submit a task
2. In a separate browser, log in as User B (Coder deployment at https://coder-b.example.com)
3. User B submits a task
4. **Expected:** User A's task uses coder-a.example.com credentials
5. **Expected:** User B's task uses coder-b.example.com credentials
6. **Expected:** Neither user's credentials are used for the other's task

### Test Case 3: Workspace Actions Use Per-User Credentials
1. Log in as User A
2. Navigate to /workspaces
3. **Expected:** Workspace list shows User A's workspaces from their Coder deployment
4. Click on a workspace to view sessions
5. **Expected:** Sessions load using User A's Coder credentials

### Test Case 4: Workspace Proxy Per-User Isolation
1. Log in as User A, open a workspace terminal
2. **Expected:** Proxy uses User A's token for upstream requests
3. In a separate browser, log in as User B
4. User B opens a workspace terminal
5. **Expected:** Proxy uses User B's token, not User A's
6. **Expected:** metaCache is keyed by userId:workspaceId — no cross-user cache hits

### Test Case 5: Unauthenticated Access Blocked
1. Clear all cookies (no session)
2. Navigate to /workspaces
3. **Expected:** Redirected to /login
4. Make a direct API call to /api/workspace-proxy/{workspaceId}
5. **Expected:** 401 Unauthorized response
6. Make a direct API call to /api/templates/status
7. **Expected:** 401 Unauthorized response

### Test Case 6: Template Operations Use Per-User Credentials
1. Log in as User A
2. Navigate to /templates
3. **Expected:** Template staleness check uses User A's Coder credentials
4. Push a template update
5. **Expected:** Push worker resolves User A's token for the coder CLI child process

### Test Case 7: No Static Env Var Dependency
1. Ensure CODER_URL and CODER_SESSION_TOKEN are NOT set in environment
2. Start the application
3. **Expected:** Application starts without errors
4. Log in and perform all operations
5. **Expected:** Everything works using per-user database credentials

### Test Case 8: User With Expired/Missing Token
1. Log in as User A
2. Delete User A's CoderToken from the database
3. Try to list workspaces
4. **Expected:** Action returns error about re-authentication (NO_TOKEN)
5. Try to submit a task
6. **Expected:** Worker job fails with clear error message about missing token

### Edge Cases
- User whose CoderToken has corrupted ciphertext → DECRYPT_FAILED error, not crash
- Missing ENCRYPTION_KEY env var → decrypt throws, propagated as DECRYPT_FAILED
- Legacy tasks with null userId → worker fails immediately with clear error message
