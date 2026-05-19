---
'hive-web': patch
'hive-terminal': patch
'@hive/web': patch
'@hive/terminal-proxy': patch
---

fix(auth): default AUTH_SERVICE_URL to in-cluster Service, treat empty as unset

The hive-web and hive-terminal charts previously shipped `AUTH_SERVICE_URL: ""`
in their default ConfigMap. Combined with the `??` operator in the client code,
this resulted in a literal empty `baseUrl`, so `fetch(\`${baseUrl}/login\`)`
threw `Failed to parse URL from /login` rather than falling back to the local
default.

- Charts now default `AUTH_SERVICE_URL: "http://hive-auth"` (the in-cluster
  Service rendered by `hive-auth` when `Release.Name = hive-auth`). Operators
  deploying under a different release (e.g. an umbrella where the Service
  renders as `<umbrella-release>-hive-auth`) MUST override this value.
- Client code in `src/lib/auth/service-client.ts` and
  `services/terminal-proxy/src/auth.ts` switched from `??` to `||` so an
  explicitly empty `AUTH_SERVICE_URL` env var also falls through to the
  local dev default (`http://localhost:4400`).
