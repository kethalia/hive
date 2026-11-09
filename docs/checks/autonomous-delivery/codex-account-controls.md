# Managed Codex account controls (source checkpoint)

This Codex-first F10 slice is default-off (`HIVE_CODEX_ACCOUNTS_ENABLED=true` is
required alongside the existing portable agent-tools enrollment). It adds an
Accounts card to the existing native workspace Agent Tools window. It is not
complete F10 or account-backed/browser acceptance.

The exact existing managed `codex-cli 0.165.0` executable was checked against the
installer's SHA256 `c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5`.
Its generated JSON schema confirms `chatgptDeviceCode`, account reads, cancellation,
and logout. No runtime upgrade, real sign-in, provider mutation, template sync,
deployment, or credential transfer was performed.

The implementation uses the [official app-server account protocol](https://learn.chatgpt.com/docs/app-server):
`account/login/start`, `account/read`, `account/login/cancel`, `account/logout`, and
the matching login-completed notification. Device login shows the official link
and one-time code; it requires no terminal or pasted callback URL. The user still
enters the device code on the provider's page. [Device-login prerequisites](https://learn.chatgpt.com/docs/auth)
remain provider/account controlled.

Only the software profile's fixed managed root
`~/.local/share/hive/codex-native/codex` is selected. The default/personal CLI root
and user-managed configuration are separate and are neither copied nor edited.
The existing issuer, owner/workspace/build checks, process-lifetime proof and
package pins authorize the fixed capability; callers cannot supply an executable,
credential root, token, URL, or arbitrary RPC. Only sanitized status and the
temporary device code reach the UI. Provider credentials stay with the official
workspace-local CLI and are not stored in Hive's database or browser storage.

One pending attempt is serialized and deduplicated per host lifetime. Mutation
generation and lifetime checks reject stale tabs and late notifications. Local
attempts expire after at most ten minutes. Cancellation/logout close the exact
auth process before a fresh credential read under the same lock; missing ACKs
are not success. Disconnect is local managed-runtime logout, not a claim of
global account/session revocation. Client cancellation can lose an ACK without
cancelling an accepted operation; refresh status before another mutation.

The auth-only app-server and the managed native app-server share a private,
no-follow `flock` whose descriptor is inherited by the child. Account changes
are **busy while the managed native runtime exists**, including idle time after
a turn. The UI does not stop/restart threads. That runtime must actually close
before this auth-only adapter can proceed. Full live-runtime reconnect/logout
remains a gate; a future bounded same-app-server account capability could reuse
the supervisor's private native RPC, but must not widen transcript RPC methods or
bypass guardian, owner/build, task or writer fences.

Local proof combines mocked provider/app-server replies, real OS lock contention
and inherited-descriptor lifetime, API origin/session/shape tests, component
tests, and actual Workerd signed service/client/host transport with a synthetic
auth process. No account-backed browser acceptance or provider revocation proof
follows. Packaging must be regenerated/reviewed by the coordinating root before
any deployment. The native package needs `codex-managed-auth-lock.mjs`; the agent
package needs the bundled `codex-account.mjs` plus its updated manifest/installer.

## Claude CLI prototype

A separate default-off `HIVE_CLAUDE_ACCOUNTS_ENABLED=true` capability now uses the
existing signed bridge and Accounts window. It executes only the **unmodified**
official CLI's `auth login`, `auth status --json`, and `auth logout`. The
[documented browser flow](https://code.claude.com/docs/en/authentication) opens the
official URL and accepts one one-time code in Hive; no terminal or pasted callback
URL is required. One bounded printable code is fed once to the exact CLI's PTY,
then cleared from the UI. Unknown outcomes are never automatically resent. The
CLI retains its verifier, token exchange and saved credentials. No private OAuth
endpoint, SDK consumer login, `setup-token`, credential parser or new service is
implemented.

[Hosted CLI conditions](https://code.claude.com/docs/en/legal-and-compliance)
apply to this unmodified CLI path and the user's own account. The separate
[Agent SDK restrictions](https://code.claude.com/docs/en/agent-sdk/overview) remain
unchanged. This adapter does not use the SDK to implement consumer login.

The bridge selects its existing configured `CLAUDE_CONFIG_DIR`, falling back to
`~/.claude`; callers cannot select paths or executables. Only exact verified
2.1.312 and 2.1.319 binaries are supported. The future image baseline is 2.1.319;
no running workspace is upgraded. Official release manifests and signatures were
verified against the [published signing key](https://code.claude.com/docs/en/setup#verify-the-manifest-signature).
Sanitized [312](codex-account-local/claude-2.1.312-release.json) and
[319](codex-account-local/claude-2.1.319-release.json) receipts record hashes.
Unknown refreshed CLI versions hold until their interaction contract is verified.

An exclusive private, no-follow lock serializes Hive account operations and is
inherited by the CLI process. Generation, host lifetime, owner and build fences
reject stale requests. Cancellation waits for the exact process before a fresh
official status read. Logout changes local saved CLI credentials; unmanaged live
CLI processes and provider-global sessions are outside that lock and revocation
claim. No existing auth home is copied.

Actual unmodified CLI probes used empty temporary config inside a network
namespace with browser openers disabled. Both [312](codex-account-local/claude-2.1.312-framing.json)
and [319](codex-account-local/claude-2.1.319-framing.json) exposed the expected
official URL/code prompt, accepted one synthetic input, rejected a duplicate,
retained the inherited lock and cancelled into fresh signed-out status. They made
zero provider requests and created no credentials. Unit/API/component tests and
an actual Workerd signed-transport proof use synthetic local provider results;
none proves real sign-in, browser acceptance, provider revocation or complete F10.

Coordinated packaging must add bundled `claude-account.mjs` and the fixed
`claude-account-driver.py` to the existing agent archive/manifest, installer and
startup checks. Profile assets remain unsynchronized pending root integration.

## F07 follow-up in this slice

The identified remaining terminal rename/kill actions used Node `coder ssh` and
were deliberately excluded from the portable action manifest. This slice adds
fixed signed `rename-terminal-session` / `kill-terminal-session` verbs for the
ordinary `tmux -L web` server, exact `=name` targets, bounded safe names and
reserved `git-clone-*` rejection. No shell, caller-selected socket/path, retry,
or managed-native terminal authority is added. Root owns the corresponding
server-action wiring and manifest changes. Real provider/browser acceptance
remains separate.
