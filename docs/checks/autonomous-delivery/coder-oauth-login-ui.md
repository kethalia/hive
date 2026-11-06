# Coder browser login presentation

F09 implementation checkpoint, November 6. The user's new direction supersedes its
earlier roadmap-only deferral. F10 agent account connections remain separate/deferred.

The configured native Preview presents Continue with Coder, navigating by a native anchor link to `/api/auth/coder/start`. Coder authenticates/asks consent and returns to
the exact configured `/api/auth/coder/callback`; successful backend completion issues
an ordinary Hive session and redirects to workspaces. There is no provider URL prompt,
client-side token exchange, client-secret serialization or Coder password collection
when enabled. The link uses the shared Base UI Button’s anchor render mode and link semantics;
it uses no Next Link prefetch or custom client navigation handler. This lets the server redirect to Coder without submitting a form: Chrome
can enforce `form-action 'self'` on cross-origin form redirects. CSP remains unchanged.

`src/app/login/page.tsx` is explicitly force-dynamic. It reads current session and
server-only configuration readiness on each request, not at build time. The shared
`getCoderOAuthConfig` validator is projected to an enum only. Enabled but unavailable
configuration renders a fixed unavailable state with no live start action and no
legacy password fallback. Disabled Node/Kubernetes deployments retain the existing
email/password form. Callback failures render only the backend's fixed
`error=coder_oauth_failed` label as generic retry copy; raw error text/code/state
parameters are neither rendered nor forwarded into navigation.

Read-only Creative Studio references informed the flow boundary. Hive uses a static
confidential client provisioned separately per deployment; it does not copy Studio's
dynamic client registration, administrator-only ownership model or account UI. Backend
PKCE, one-use browser-bound state, encrypted credentials, refresh and normal session
issuance belong to the separately reviewed F09 backend slice.

The public Preview access change is independent: no extra preview bearer/cookie is
needed to view ordinary login. Standard Hive sessions, CSRF, fixed Coder identity and
owner isolation still apply. The offline production preparation helper strips all
Preview `HIVE_CODER_OAUTH_*` variables, so the Preview client cannot silently enter
production. Production OAuth requires explicit independent enrollment metadata and the
owner's cutover approval.

Validation: 14 focused login/readiness/legacy-routing cases pass locally. They cover configured/disabled/unavailable presentation, fixed navigation,
no credential fields or serialized secrets, sanitized failure handling and production
isolation. The native full-app Workerd proof now defaults to synthetic fixture OAuth
configuration and checks the actual SSR anchor link with no email/password inputs; an
explicit `--legacy-login` mode retains compatibility coverage. It keeps existing
session/logout/owner/isolation checks and uses no live OAuth provider credentials.
Those source changes do not themselves establish an executed native proof or real
Coder consent. Backend fixture/SQL evidence, the exact assembled candidate proof and
actual dedicated-account Browser Testing sign-in/return remain independent gates.
No provider operation, secret provisioning or deployment was performed by this UI slice.
