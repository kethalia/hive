# Account connection reference audit

Recorded 2026-11-05. Roadmap only; no login flow, account mutation or authentication
implementation was performed for this addition.

The reference is the existing Creative Studio admin worktree at
`/home/coder/projects/kethalia/.worktrees/codex-creative-studio/integration-01-core`,
HEAD `73615a5f4479975cbfda2140c8e16d0027b5f125`. Inspection was read-only. The primary
Creative Studio checkout is separate and contains user work; it was not modified.

| Reference file, relative to that worktree | Verified behavior |
| --- | --- |
| `apps/studio-cloud/src/coder-oauth.ts` | Fixed-origin discovery, authorization code with S256 PKCE, browser-bound state and confidential dynamic client registration. |
| `apps/studio-cloud/src/coder-oauth-storage.ts` | Server-side registration and one-use pending authorization records. |
| `apps/studio-cloud/src/coder-credentials.ts` | Encrypted client/access/refresh credentials; refresh is coordinated with a lease and compare-and-swap. |
| `apps/studio-cloud/src/coder-provider.ts` | OAuth access token still authenticates Coder API requests. |
| `docs/design/coder-browser-sign-in.md` | Provider/registration prerequisites, scope and lifecycle limits; recorded API checks do not establish complete authenticated browser acceptance. |
| `apps/studio-server/src/codex-auth.ts` | Dedicated app-server `account/login/start` using `chatgptDeviceCode`, with pending/completed/cancelled state. |
| `apps/creator-web/src/codex-authentication.tsx` | In-app device code and external provider sign-in page. |

Hive currently accepts Coder email/password in `services/auth/src/auth/login.ts`,
then retains an encrypted managed API key or session token through `CoderToken` and
`src/lib/coder/user-client.ts`. Password replacement and removal of all server-side
credential storage are different changes. OAuth supports the former in the reference;
the latter requires a separate decision about refresh and unattended execution.

F09 adapts the Coder reference to Hive's fixed instance and per-user ownership.
F10 adapts the account-connection experience to a native Hive window and the intended
workspace runtime. Validate the installed official Codex interfaces before implementation.
No equivalent Claude connection implementation was found in this reference; its official
supported flow and credential lifecycle remain an explicit research item.

See [epic F09/F10](../../autonomous-delivery-epic.md#account-connection-refactoring-added-2026-11-05)
for sequencing, migration and acceptance requirements.
