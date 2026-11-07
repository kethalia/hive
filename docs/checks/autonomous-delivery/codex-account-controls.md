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

## Claude follow-up

Installed Claude Code 2.1.312 exposes `auth login`, `auth status --json`, and
`auth logout`. Its [documented browser flow](https://code.claude.com/docs/en/authentication)
can ask for a one-time code in the terminal. A native one-time-code field is not
excluded by F10's no-terminal/no-callback-URL requirement. A wrapper around the
**unmodified** CLI may therefore be viable, but stable bounded URL/code/stdin
interaction and cancellation still need exact installed-interface validation;
no private OAuth endpoints or SDK consumer-login workaround is authorized here.

[Hosted CLI conditions](https://code.claude.com/docs/en/legal-and-compliance)
allow unmodified Claude Code under their stated terms, retaining built-in auth
methods and each user's own credentials. Separately, the
[Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview) restricts
third-party claude.ai login without approval. These are different integration
paths. Claude remains unimplemented, so F10 remains incomplete.

## F07 follow-up in this slice

The identified remaining terminal rename/kill actions used Node `coder ssh` and
were deliberately excluded from the portable action manifest. This slice adds
fixed signed `rename-terminal-session` / `kill-terminal-session` verbs for the
ordinary `tmux -L web` server, exact `=name` targets, bounded safe names and
reserved `git-clone-*` rejection. No shell, caller-selected socket/path, retry,
or managed-native terminal authority is added. Root owns the corresponding
server-action wiring and manifest changes. Real provider/browser acceptance
remains separate.
