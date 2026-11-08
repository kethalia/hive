# Request-bound database callback build validation

Cloudflare build `ca3376a8-2715-46ee-8de9-a1ed8049ef46` for the epic failed
because the installed database-report route dynamically imported the Worker-only
Prisma factory into Next's webpack graph. Its WASM module reached the Node loader.

The report store now captures an optional sibling factory from its live database
request scope. The existing outer Worker binds that factory to the original URL;
the callback creates its own client/pool with the existing 2500 ms query/connection
and 5000 ms transaction bounds. Closing the parent does not close or reopen the
sibling. Capture outside a live scope fails closed. Missing capability preserves
already committed report facts and leaves advancement held. The existing 20-second
work budget, five-second cleanup reserve, cancellation and close remain unchanged.
No URL, credential or factory is serialized; there is no global client fallback.

The final source passed canonical `pnpm build:cloudflare` in the existing checkout
with ordinary source, dependency and output paths, followed by the existing single
`hive` Worker's `wrangler deploy --dry-run`. Next, OpenNext and Wrangler compilation
and packaging passed without upload. The ready receipt records 288 outputs; its
SHA-256 is `e81851faec9ad9a6fc214d1125edeed64f8295212188886914f11f330b698116`.
The build identifies itself as a non-provider build. Tracked source inputs stayed
unchanged; the canonical Prisma regeneration refreshed only its ignored temporary
schema-path metadata before the ready receipt pinned the final generated inputs.
Earlier redirected-output staging attempts did not preserve tracing equivalence;
their Sharp errors are not treated as production failures or acceptance evidence.

Twenty focused request-scope/real-adapter-bounds/proxy tests passed. Three composed
PostgreSQL cases passed: absent capability retains an authenticated SQL report and
its held action, a stalled provider cancels and closes its own client in 21.3 seconds,
and scheduled recovery progresses only with fresh SQL and exact serving proof.
TypeScript, formatting and independent source review passed. The existing required
CI Build command now also runs the canonical Cloudflare compile, alongside its Node
build and checks. No new workflow, publisher or token was introduced. Host archives, migrations
and deployment configuration are unchanged. Deployment and live runtime acceptance
remain separate gates.
