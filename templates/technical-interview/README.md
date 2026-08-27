# Technical Interview Workspace on Kubernetes

This standalone Coder template provides an isolated browser-capable environment for the Proton.ai
technical interview. It prepares the public assessment repository without implementing any
interview feature.

## Runtime and isolation

- Template: `technical-interview`
- Profile: `interview` (`Technical interview`)
- Image variant: `browser`, with a standalone digest that initially matches `browser-testing`
- Main development container: 4 CPU and 8 GiB requested; 8 CPU and 16 GiB limits
- Isolated Claude container: 100m CPU and 256 MiB requested; 2 CPU and 2 GiB limits
- Persistent home: a dedicated 50 GiB Longhorn volume
- Temporary-key boundary: an owner-only `claude` Coder agent in a second container, with an
  ephemeral home, a separate PID namespace, and only the persistent `projects` subtree mounted
- Browser: Chrome, XFCE/KasmVNC, and Playwright MCP
- User-space toolchain: Codex, Playwright MCP, Bun, and pnpm, pinned and prepared during startup
- GitHub external auth, Git helpers, commit signing, and Coder CLI login: not provisioned
- Active global agent context: interview guidance only

The template remains non-root, receives no Docker socket or Kubernetes service-account token, and
creates only owner-shared Coder applications. It clones only
`https://github.com/prmsolutions/interview-template.git` and preserves any existing checkout.
It does not participate in canonical template synchronization and does not change any existing
template or workspace.

Open the owner-only **Interview Claude** Coder application for the fixed masked temporary-key prompt.
Generic SSH and Web Terminal buttons are hidden for the dedicated Claude agent. The main development
container cannot enter its process namespace. The non-dumpable launcher retains the real key in a
private Unix-socket broker that accepts only the protected Claude process and forwards only
Anthropic v1 API paths to `api.anthropic.com`; Claude and all candidate-controlled commands receive
only a non-secret placeholder. The launcher's fixed environment excludes every workspace,
orchestration, and personal credential, while the guard removes the private broker route before
Claude can execute hooks, shell commands, or stdio MCP servers. A trusted Kubernetes init container
installs and validates the pinned Playwright MCP payload before either runtime starts. The candidate
container never mounts that volume, and Claude mounts it read-only; browser state remains confined
to Claude's ephemeral home.

The first startup verifies Codex `0.149.1`, Playwright MCP `0.0.79`, Bun `1.4.0`, and pnpm `10.32.1`.
Exact matching Codex and Bun commands from the image baseline are reused; missing or mismatched tools
are installed under the workspace's private user-state directory. Playwright MCP uses the image's
Chrome binary directly and never downloads a browser during the interview.

## Publish and provision

```bash
coder templates push technical-interview --directory templates/technical-interview --yes
coder create --template technical-interview proton-interview
coder ssh proton-interview -- bash -lc 'interview-check'
```

Inspect `coder templates push --help` and `coder create --help` when the installed CLI differs. Never
delete or recreate an existing `proton-interview` workspace or its volume merely to update it.
