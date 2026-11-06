# OAuth navigation from deployment previews

The reported Safari tab used `https://7a7e9134-hive.b00ste.workers.dev`.
Its relative `/api/auth/coder/start` link stayed on that deployment-specific host.
Coder is registered for the stable branch Preview origin, so the existing origin
check rejected that request before allocating a flow. A bounded HTTP reproduction
returned 400 with no body or content type; the supplied Safari screenshot shows a
`start` download prompt. The stable branch endpoint returned 303 to the fixed
Coder authorization endpoint instead. No authorization URL query or cookie value
is recorded here.

The login page now projects only the validated public start URL from server config
and renders an absolute native link. This places the flow cookie on the origin
registered with Coder, including when the page itself is opened on a new immutable
preview host. Invalid starts still return 400 without a service call or Set-Cookie,
with readable text/plain content and nosniff. Provider/callback allowlists, CSRF,
host-only cookies and CSP are unchanged; no new provider callback is registered.
Existing immutable deployments retain their previous code: use the stable branch
Preview URL for sign-in.

Validation: 22 focused route, config, server-page and component checks pass;
full TypeScript, Biome and diff checks pass. Regression checks cover absolute URL
resolution from the reported deployment host, confidential config exclusion and
readable rejected responses with zero flow allocation. Independent source review
also verified both hosts' same-site relationship using the installed public-suffix
data. Cloudflare published `81e5e084` successfully. Four bounded live HTTP requests
verified stable and new deployment login links, readable noncanonical rejection
without a browser-flow cookie, and the canonical redirect/client/callback/PKCE
binding. See the [live receipt](coder-oauth-preview-alias-live.json). No Safari
automation or whole-epic/production acceptance is claimed.
