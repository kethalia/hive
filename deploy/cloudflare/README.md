# Hive Cloudflare edge

Hive's web runtime currently relies on Node child processes, local template files, BullMQ workers,
and long-lived terminal services. Those responsibilities remain on the Kubernetes origin. This
Worker is the Cloudflare front door: it proxies HTTP and WebSocket upgrades, caches only anonymous
public assets, preserves private responses as `no-store`, and applies edge security headers.
Origin cookie domains are removed at the edge so session cookies remain host-only on the public
Worker or custom domain instead of leaking the private GitOps hostname into browser policy.

## Configure and preview

1. Authenticate Wrangler with the target Cloudflare account.
2. Set the origin as a Worker secret so environment-specific hostnames do not enter Git:

   ```sh
   cd deploy/cloudflare
   printf '%s' "$HIVE_ORIGIN" | pnpm dlx wrangler@4 secret put HIVE_ORIGIN
   ```

   `HIVE_ORIGIN` must be the HTTPS GitOps origin, not the public hostname routed to this Worker.
   Terminal and audio transports use short-lived request tickets issued by Hive;
   the account cookie remains host-only even when the terminal has another hostname.
   `PUBLIC_COOKIE_DOMAIN` is retained only to expire legacy shared `hive-session`
   cookies during migration. It never adds Domain to a live cookie. Remove this
   setting once the old cookies have expired.

   Set `HIVE_PUBLIC_ORIGIN` on the web service to the exact public origin so the
   ticket issuer can validate browser Origin behind this Worker. If a separate
   terminal edge rewrites Host, set `TERMINAL_PUBLIC_ORIGIN` on the terminal service
   to its exact public origin too.

   For browser voice, configure `HIVE_PUBLIC_ORIGIN` on the Hive web service to
   the exact public Worker/custom-domain origin (for example
   `https://hive.example.com`). The voice route checks this value against `Origin`
   and the Worker's forwarded host/protocol. Set `HIVE_CODEX_VOICE_ENABLED=true`
   on the web service as well; neither setting belongs in the Worker environment.

3. Upload a preview version:

   ```sh
   pnpm dlx wrangler@4 versions upload
   ```

4. Exercise the generated `workers.dev` URL before attaching a custom route. Confirm that `/` is
   cacheable, `/login` and all authenticated routes are `private, no-store`, authentication cookies
   remain scoped to the public Hive hostname, and terminal WebSocket connections upgrade cleanly.

5. After preview validation, deploy and attach the intended custom domain in Cloudflare:

   ```sh
   pnpm dlx wrangler@4 deploy
   ```

Do not route the terminal hostname through this Worker unless the runtime config and origin support
that topology. Hive already publishes the terminal WebSocket URL independently.

Cloudflare's official Next.js Workers guide recommends OpenNext for edge-compatible full-stack
applications. Hive cannot use that adapter for the whole runtime until child-process, filesystem,
queue-worker, and terminal responsibilities have been extracted behind network services:
https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
