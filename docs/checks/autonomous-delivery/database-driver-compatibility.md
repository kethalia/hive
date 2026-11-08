# Application database transport compatibility

The source-build compatibility harness runs the unchanged built Worker modules
through local Miniflare. Its outbound service accepts only the fixture database's
Neon WebSocket endpoint and forwards it to a bounded loopback TCP bridge. It rejects
other application egress. Both transport modes verify the configured PostgreSQL
startup user and database before forwarding. Neither the application artifact, PrismaNeon driver nor
global Neon configuration is modified.

The synthetic CI/Docker PostgreSQL service uses password host authentication for
Neon's existing password pipeline. A separate passwordless local-fixture path
requires the server's actual AuthenticationOk before discarding only the initial
pipelined Password packet. Unknown authentication, invalid startup/SSL frames and
nonfixture targets reject. Each version must complete a successful application SQL
exchange backed by CommandComplete and successful ReadyForQuery; Sync, empty
queries and failed commands cannot establish SQL credit. A scenario using only
psql or HTTP assets cannot pass.

The local regression builds two different small artifacts with the actual native
Worker composition, request-scoped PrismaNeon factory and authentication domain.
It exercises old/new writes and reads, shared disposable encryption keys, production
session creation/cookie verification, cross-version user updates/logout and static
assets. This is a composition fixture, not two full Next builds or an OAuth login.
Fourteen additional wire/egress tests cover the isolated protocol boundary. The same
composition scenario passes both a passwordless trust fixture and a separate
password-authenticated PostgreSQL fixture. The retained legacy workerd scenario
also passes. CI runs the source scenario using its password-authenticated service.

A separate historical-artifact check used two instances of the same preserved
OpenNext build from source `5104c4a709389d5dc40b71c34e3d979d563b215a`, build ID
`47694f57-034d-42e7-89e4-44267c047bb1`. Both actual compiled notification-source
DELETE routes returned 200 and reached PostgreSQL through the canonical request
factory and auth binding: two connections and four successful SQL exchanges per
instance. The two owned rows were deleted while a foreign row and the shared
session remained. All 279 recorded artifact hashes matched before and after.
Normal local Wrangler packaging supplied the historical bundle's builtin aliases;
no artifact or driver source was patched. This proves the real compiled app route
can use the isolated transport; it does not claim two historical source versions,
the current candidate's full Next build, provider login or production acceptance.

All database rows, passwords and crypto keys were disposable local fixtures. No
production configuration, provider resource, production database or live job was
changed. Actual old/new production-source builds and the enrolled reviewed scenario
remain gates of the existing controlled compatibility workflow.
