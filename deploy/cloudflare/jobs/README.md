# Durable notification dispatch

The Worker wake-up drains PostgreSQL's delivery outbox; PostgreSQL owns retry timing,
claims and stale-worker fences. It has no HTTP control endpoint, process-local timer,
Redis dependency or browser-provided owner identity. Configuration ships with no cron,
no public endpoint and dispatch disabled. Deployment/activation remains separate.

Each invocation handles at most five owners and one notice per owner. Per notice it
sends to at most fifty device subscriptions, in parallel with ten-second network
bounds; more than fifty subscriptions marks that notice failed instead of silently
skipping devices. Disabled device preferences and zero subscriptions acknowledge push
without deleting the durable report. Expired subscriptions are removed only with their
matching owner and endpoint. Other provider errors use bounded outbox retry/backoff.
Stable event tags collapse duplicate notifications after an ambiguous network result;
this is at-least-once delivery, not exactly-once provider delivery.

Runtime bindings are the restricted application DATABASE_URL and VAPID_SUBJECT (or
HIVE_PUBLIC_ORIGIN). Existing VAPID keys stay in the application database. Database
connections live only for the awaited invocation, including all provider requests.
No provider response body, endpoint, user identity or credential is logged by this
Worker. A bounded aggregate dispatch result is logged.

Local workerd encryption/Fetch adapter evidence is under
`docs/checks/autonomous-delivery/push-workerd.json`; provider responses in that probe
are simulated, with zero external pushes. Actual scheduled dispatcher, authenticated
browser subscription and real device delivery remain acceptance checks. Other Hive
background jobs, including credential rotation and template operations, have separate
migration work; this file does not claim F07 complete.

The optional token-warning dispatcher uses `HIVE_TOKEN_WARNING_DISPATCH_ENABLED=false`.
It reads owner/token-version/expiry metadata, rechecks it before sending, honors token preferences,
and uses a separate durable warning outbox. It needs the fixed `CODER_URL` and existing VAPID
configuration, not `ENCRYPTION_KEY`. The auth Worker owns rotation and its independent default-off
schedule. See the [rotation checkpoint](../../../docs/checks/autonomous-delivery/token-rotation-scheduling.md)
for bounds, uncertainty holds and the required Node scheduler cutover.
