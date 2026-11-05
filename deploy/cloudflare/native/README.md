# Hive native Worker Previews

This configuration targets the single `hive` Worker in account `225177f82b9234ede14e897fe15e0cb5`. The top-level Worker is an inert bootstrap: it has no database, route, cron, service or production secrets. `production` deployment through this helper is refused until a separately reviewed cutover changes the implementation. A successful Preview is not a production deployment.

Native Previews use the `previews` block and the exact Git branch as the Preview name, matching Workers Builds. Before a real upload, the helper reads that existing Preview from the fixed Cloudflare account using `CLOUDFLARE_API_TOKEN`, requires the provider's name to match the branch, and validates its returned DNS slug. It sets both origin variables to `https://<provider-slug>-hive.b00ste.workers.dev`. Missing metadata or a missing token fails closed; the helper never creates a Preview under a guessed name. Check the provider-returned URL before use. Preview cookies are origin-bound. Use the native Preview URL, not an ordinary Worker version URL, whose bindings may differ.

Branch Previews share the dedicated synthetic preview database; they do not isolate data from each other. No R2 bucket or service binding is configured. Discovery, task execution, delivery, host gateway, dispatch and token rotation start disabled. Preview schedules remain disabled. Delivery-enabled acceptance requires a separately reviewed branch and matching host issuer and enrollment.

Only trusted same-repository branch code may use this shared Preview Base. Preview code can read its Base secrets and directly access its database even when application features are disabled. Do not enable automatic builds for untrusted forks or arbitrary PR code; use independently provisioned branch resources and secrets before relaxing that restriction. Base configuration may also add provider-managed bindings, so inspect it before enabling builds and verify each deployed Preview's effective bindings.

Before connecting Workers Builds, provision the parent Worker and configure its Previews Base with **preview-only** values for `DATABASE_URL`, `ENCRYPTION_KEY`, `COOKIE_SECRET`, `AUTH_SERVICE_SECRET`, `PREVIEW_BEARER`, and `PREVIEW_COOKIE_SECRET`. The database must be the isolated preview database with its restricted runtime role. Existing encryption/session/issuer keys must be retained where existing preview data or issued tokens depend on them. Do not put secret values into Git, config, build variables, or arguments. Base secrets apply to newly created Previews; updating an existing Preview requires the separate native Preview secret command. Missing secrets leave the Preview unavailable. Preview URLs are publicly reachable, and the app's preview bearer/cookie gate must be configured and verified before use.

Recommended Workers Builds configuration, after the provider connection and Base configuration are reviewed:

- Repository root: `/`; toolchain and lockfile from this repository.
- Build: `pnpm install --frozen-lockfile && pnpm build:cloudflare`.
- Non-main deployment: `node deploy/cloudflare/native/deploy.mjs preview` using `WORKERS_CI_BRANCH` provided by Workers Builds. An associated PR receives the provider's build status and Preview URL when its integration is enabled.
- Main: do not configure automatic production deployment until cutover is authorized. The helper rejects a production deployment and rejects `main` for Preview deployment.

Local checks, without provider calls:

```sh
WORKERS_CI_BRANCH=codex/example node deploy/cloudflare/native/deploy.mjs preview --check
WORKERS_CI_BRANCH=codex/example node deploy/cloudflare/native/deploy.mjs preview --dry-run
WORKERS_CI_BRANCH=main node deploy/cloudflare/native/deploy.mjs production --check
node --test deploy/cloudflare/native/deploy.test.mjs
```

The dry run compiles equivalent Preview-safe bindings with a local-only placeholder origin using `wrangler deploy --dry-run`; native `wrangler preview` itself has no dry-run option. Run `pnpm build:cloudflare` first so the generated app and portable-action artifacts exist. Neither `--check` nor `--dry-run` contacts the provider or determines a real Preview origin. Neither validates remote Base secrets, provider routing, Neon identity, PR integration, or deployed behavior. Keep existing pilot Workers and data until the replacement is independently validated.

References: [Cloudflare Preview configuration](https://developers.cloudflare.com/workers/previews/configuration/) and [Preview resource isolation](https://developers.cloudflare.com/workers/previews/resources/).
