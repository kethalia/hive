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
   printf '%s' "$HIVE_ORIGIN" | pnpm exec wrangler secret put HIVE_ORIGIN
   ```

   `HIVE_ORIGIN` must be the HTTPS GitOps origin, not the public hostname routed to this Worker.

3. Upload a preview version:

   ```sh
   pnpm exec wrangler versions upload
   ```

4. Exercise the generated `workers.dev` URL before attaching a custom route. Confirm that `/` is
   cacheable, `/login` and all authenticated routes are `private, no-store`, authentication cookies
   remain scoped to the public Hive hostname, and terminal WebSocket connections upgrade cleanly.

5. After preview validation, deploy and attach the intended custom domain in Cloudflare:

   ```sh
   pnpm exec wrangler deploy
   ```

Do not route the terminal hostname through this Worker unless the runtime config and origin support
that topology. Hive already publishes the terminal WebSocket URL independently.

Cloudflare's official Next.js Workers guide recommends OpenNext for edge-compatible full-stack
applications. Hive cannot use that adapter for the whole runtime until child-process, filesystem,
queue-worker, and terminal responsibilities have been extracted behind network services:
https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
