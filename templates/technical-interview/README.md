# Technical Interview Workspace on Kubernetes

This standalone Coder template provides an isolated browser-capable environment for the Proton.ai
technical interview. It prepares the public assessment repository without implementing any
interview feature.

## Runtime and isolation

- Template: `technical-interview`
- Profile: `interview` (`Technical interview`)
- Image variant: `browser`, with a standalone digest that initially matches `browser-testing`
- Main development container: 4 CPU and 8 GiB requested; 8 CPU and 16 GiB limits
- Protected Claude runtime: requests 100m CPU and 256 MiB, with 2 CPU and 2 GiB limits
- Persistent home: a dedicated 50 GiB Longhorn volume
- Temporary-key boundary: an owner-only browser application encrypts the key with an ephemeral
  runtime public key; the immutable main-agent client receives only a one-time pairing code
- Protected Claude runtime: no Coder agent or Coder token; only this runtime decrypts the key,
  executes Claude, and mounts its own ephemeral home
- Browser: Chrome, XFCE/KasmVNC, and Playwright MCP, with normal Chrome launches confined to a
  pod-ephemeral profile
- User-space toolchain: Codex, Playwright MCP, Bun, and pnpm, pinned and prepared during startup
- GitHub external auth, Git helpers, commit signing, and Coder CLI login: not provisioned
- Persisted Codex, browser, cloud, cluster, registry, IaC, and orchestration credential stores: strict
  readiness failure without reading or deleting them
- Active global agent context: interview guidance only

The template remains non-root, receives no Docker socket or Kubernetes service-account token, and
creates only owner-shared Coder applications. It clones only
`https://github.com/prmsolutions/interview-template.git` and preserves any existing checkout.
It does not participate in canonical template synchronization and does not change any existing
template or workspace.

Start the owner-only **Interview Claude** application (or run `interview-claude`) to receive a
one-time pairing code. Open **Interview Claude Key** and enter that code plus the temporary key.
WebCrypto encrypts the key with the protected runtime's ephemeral RSA-OAEP public key before the
request enters the workspace network. The fixed terminal client never reads or receives the real
key, so candidate-owned PTYs cannot capture it. The sibling runtime has no Coder agent, Coder token,
SSH endpoint, or web terminal, and it rejects additional launches promptly while a session is
active. The non-dumpable runtime retains the decrypted key in a private Unix-socket broker that
accepts only the protected Claude process and forwards only Anthropic v1 API paths to
`api.anthropic.com`; Claude and all candidate-controlled commands receive only a non-secret
placeholder. The guard removes the private broker route before Claude can execute hooks, shell
commands, or stdio MCP servers. A credential-free trusted Kubernetes sidecar installs and validates
the pinned Playwright MCP payload in a pod-local volume. The main recovery environment starts
independently if registry access is unavailable, while the protected runtime waits for the
atomically promoted payload and the staging sidecar retries. Claude browser state remains confined
to the runtime's ephemeral home.

The first startup verifies Codex `0.149.1`, Playwright MCP `0.0.79`, Bun `1.4.0`, and pnpm `10.32.1`.
Exact matching Codex and Bun commands from the image baseline are reused; missing or mismatched tools
are installed under the workspace's private user-state directory. Stored payload fingerprints catch
missing runtime files even when a launcher still reports the pinned version. npm and pip operations
ignore persisted user configuration and environment overrides, disable interactive credential
lookup, and setup rejects repository `.npmrc` files before running project npm commands. Readiness
rejects preserved `.npmrc` or pip configuration paths rather than reading or deleting them. Standard
Codex, browser, and cloud credential stores are handled by the same preserve-and-fail policy. Normal
Chrome launches use an emptyDir-backed profile, so browser sessions do not enter the persistent
home. `interview-start` also replaces an active API or frontend service pane when
its health endpoint is unavailable while preserving the work and AI panes. Playwright MCP uses the
image's Chrome binary directly and never downloads a browser during the interview.

## Publish and provision

```bash
coder templates push technical-interview --directory templates/technical-interview --yes
coder create --template technical-interview proton-interview
coder ssh proton-interview -- bash -lc 'interview-check'
```

Inspect `coder templates push --help` and `coder create --help` when the installed CLI differs. Never
delete or recreate an existing `proton-interview` workspace or its volume merely to update it.
