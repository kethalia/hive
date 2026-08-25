# Technical Interview Workspace on Kubernetes

This Coder template provides an isolated, reusable browser-capable environment for time-boxed
full-stack assessments. Its initial anonymous repository bootstrap is tailored to the public
Proton.ai interview template without implementing any interview feature.

## Runtime and isolation

- Template: `technical-interview`
- Profile: `interview` (`Technical interview`)
- Image variant: `browser`, pinned to the same digest as `browser-testing`
- Requests: 4 CPU and 8 GiB memory; limits: 8 CPU and 16 GiB memory
- Persistent home: a dedicated 50 GiB Longhorn volume
- Browser: Chrome, XFCE/KasmVNC, and Playwright MCP
- GitHub external auth: disabled
- Coder CLI login: disabled
- Active global agent context: interview guidance only; shared routing is not appended

The template remains non-root, receives no Docker socket or Kubernetes service-account token, and
creates only owner-shared Coder applications. It clones only
`https://github.com/prmsolutions/interview-template.git` and preserves any existing checkout.

## Publish and provision

```bash
coder templates push technical-interview --directory templates/technical-interview --yes
coder create --template technical-interview proton-interview
coder ssh proton-interview -- bash -lc 'interview-check'
```

Inspect `coder templates push --help` and `coder create --help` when the installed CLI differs. Never
delete or recreate an existing `proton-interview` workspace or its volume merely to update it.

## Image rollout

The first template revision deliberately reuses the currently pinned browser digest and includes a
non-root, pinned `virtualenv` fallback for that transitional image. Complete rollout in this order:

1. Merge the technical-interview feature PR.
2. Wait for the workspace-image workflow to open its automated digest PR.
3. Review and merge the digest PR after its checks pass.
4. Repush `technical-interview`.
5. Update or restart `proton-interview` without deleting its volume.
6. Rerun `interview-check` and repeat the stop/start persistence verification.
