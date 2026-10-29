# Portable credential rotation and key ownership

The existing rotation cleanup enumerated user keys, then deleted every key except the newly
minted candidate. On a lost database CAS this could revoke the winner while retaining the loser;
the success path could also remove unrelated user keys. The replacement never enumerates keys.

`CoderToken.remoteKeyId` is nullable and has no backfill. Only a key minted by Hive and verified
against provider metadata receives ownership provenance. Legacy/session fallback credentials
retain NULL, and their old remote key is retained for expiry rather than inferred or revoked.
The additive migration leaves existing ciphertext intact.

`managed-keys.ts` creates a uniquely named `hive-<uuid>` token using Coder's token API. It verifies
the returned token format/ID, exact user, unique name, token login type, and finite actual expiry.
Provider metadata determines stored expiry; a shorter permitted lifetime is respected. Metadata
mismatch or redirect fails closed; no guessed or metadata-supplied alternate key ID is deleted.

This also corrects the active auth/rotation request path: Coder's session-key endpoint ignores the
old `lifetime_seconds` body. The named-token endpoint accepts `lifetime` as Go duration nanoseconds.
The verified Coder source generates an ID of 10 characters and a secret of 22 characters, joined
with a hyphen. Unknown formats are not assigned managed ownership.

Login now commits credential version, encrypted bytes, tracked key ID and session in one
Serializable transaction. A CAS conflict creates no session. A confirmed successful replacement
may revoke only the previously tracked Hive key. A failed attempt may discard only its own newly
created key after a conclusive rollback (local zero-count CAS, or known Prisma P2034/P2002).
Every ambiguous write retains its candidate for expiry/reconciliation. Reading the old committed
row cannot exclude a late commit and never authorizes destructive cleanup.

The portable `rotateCoderCredentials` operation processes at most 100 rows and returns a cursor.
It preserves origin checks, expiry notifications, encryption and version CAS. The rotation threshold
uses the actual credential generation/lifetime. A winning update stores identity/expiry atomically
and can revoke only the recorded prior Hive ID. A losing CAS deletes only its own newly created ID.
Provider cleanup failure is reported separately and cannot roll back a stored winner.

The existing Node BullMQ queue, worker and hourly schedule remain. Their wrapper drains portable
pages and forwards expiry notices through the existing push transport. No scheduler or network
operation starts from importing the portable auth domain.

## Evidence and remaining gates

- Auth package tests cover verified metadata, malformed IDs, user/expiry/name mismatch, redirects,
  first-login conflicts, lost CAS and unknown write outcomes, legacy ownership, actual lifetime,
  pagination and notification failure. Node adapter tests cover paging and push integration.
- The local workerd/isolated-Neon proof invokes the actual login credential/session transaction,
  in addition to encrypted credentials, Serializable commit/rollback, row locks and task reads.
  `cloudflare-auth-local.json` records the exact tested source digests and commit status.
- `cloudflare-auth-app.json` separately proves the actual app/auth Worker binding at its recorded
  committed revision. It predates this rotation followup and is not current rotation evidence.

No real Coder login/key mint, rotation or revocation was performed for these proofs. No cron or
cloud resource was activated. Worker scheduling still needs durable cursor/lease ownership so
bounded scans remain fair across users and retries. A process death between remote key creation
and DB persistence can leave a newly minted key until provider expiry; cleanup of an unverified
or uncertain candidate is deliberately conservative. Notification durability and operational
recovery remain separate acceptance gates. This is not complete F07 activation.

## Primary vendor evidence

- [Coder SDK token request and API key metadata](https://github.com/coder/coder/blob/v2.33.0/codersdk/apikey.go)
- [Coder token/session endpoints and duration handling](https://github.com/coder/coder/blob/v2.33.0/coderd/apikey.go)
- [Coder key generation and format](https://github.com/coder/coder/blob/v2.33.0/coderd/apikey/apikey.go)
- [Current Coder REST user/key reference](https://coder.com/docs/reference/api/users)
