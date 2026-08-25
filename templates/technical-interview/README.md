# Technical Interview Workspace on Kubernetes

This standalone Coder template provides an isolated browser-capable environment for the Proton.ai
technical interview. It prepares the public assessment repository without implementing any
interview feature.

## Runtime and isolation

- Template: `technical-interview`
- Profile: `interview` (`Technical interview`)
- Image variant: `browser`, pinned to the same digest as `browser-testing`
- Requests: 4 CPU and 8 GiB memory; limits: 8 CPU and 16 GiB memory
- Persistent home: a dedicated 50 GiB Longhorn volume
- Browser: Chrome, XFCE/KasmVNC, and Playwright MCP
- GitHub external auth, Git helpers, commit signing, and Coder CLI login: not provisioned
- Active global agent context: interview guidance only

The template remains non-root, receives no Docker socket or Kubernetes service-account token, and
creates only owner-shared Coder applications. It clones only
`https://github.com/prmsolutions/interview-template.git` and preserves any existing checkout.
It does not participate in canonical template synchronization and does not change any existing
template or workspace.

## Publish and provision

```bash
coder templates push technical-interview --directory templates/technical-interview --yes
coder create --template technical-interview proton-interview
coder ssh proton-interview -- bash -lc 'interview-check'
```

Inspect `coder templates push --help` and `coder create --help` when the installed CLI differs. Never
delete or recreate an existing `proton-interview` workspace or its volume merely to update it.
