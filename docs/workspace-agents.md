# Workspace agents and disposable helpers

## Deployment and agent audit (2026-10-25)

The inspected Coder deployment reports 2.34.7. The GitOps upgrade targets mainline
2.38.2; GitHub's stable `latest` channel was 2.37.6. The Agents API is available,
but its model response contains no providers. Deployment configuration enables
AI Gateway routing and user keys. No license is installed; advanced template
scheduling/dormancy is not entitled. Empty experiments alone do not mean Agents
are unavailable.

After the GitOps upgrade, configure providers in **Admin settings → AI**, then add
models to the intended organization under **AI → Models**. Supply either centrally
managed credentials or permitted user keys. Test a small chat before broad rollout.
Codex and Claude CLI subscriptions/authentication are independent of credentials
used by the server-side Coder Agents harness. Coder Agents can use OpenAI,
Anthropic, and an OpenAI Compatible endpoint for a hosted or self-hosted open model.
An internal endpoint needs a scoped control-plane egress rule in k8s-cluster.

See the [Coder Agents setup](https://coder.com/docs/ai-coder/agents/getting-started)
and [provider/model configuration](https://coder.com/docs/ai-coder/agents/models).
The cluster upgrade, migration checks, backup precheck, and rollback procedure live
in `kethalia/k8s-cluster/docs/runbooks/coder-agents-upgrade.md`.

## Native CLIs and registry modules

Hive keeps the repository and terminal workspace stable while users choose a CLI
and provider. CLI conversation histories remain specific to that CLI. A model
change should carry a short handoff with the branch, current state, and next action.

- Claude Code uses the official registry module 5.5.2 with installation disabled;
  the existing bounded startup updater owns CLI installation. The v5 module removes
  the old Tasks/agentapi server; a native terminal launcher replaces its app.
- Codex keeps the existing updater and user-owned config/auth with a native launcher.
  Registry module 5.4.2 writes `config.toml` on first use, even when installation is
  disabled. Adopt it only after the proposed `manage_config = false` option is
  released; do not point production templates at an unreleased fork.
- OpenCode is opt-in through the **OpenCode CLI** workspace parameter. Its official
  npm package is pinned to 1.19.4 for first installation; an existing installation
  is retained. The current coder-labs OpenCode module 0.1.3 still brings agentapi/
  Tasks dependencies, so this template uses a bounded CLI installer and terminal
  launcher. No additional web server, local model runtime, or model weights run in
  the helper workspace.
- Existing code-server, git-config, git-signing, and coder-login module pins are
  unchanged in this slice. They are independent of native agent enablement.

For OpenCode, use `/connect` for a provider and `/models` to select a model. For an
internal OpenAI-compatible service, configure its URL and model ID in your
user-owned `~/.config/opencode/opencode.json` following the
[official provider guide](https://opencode.ai/docs/providers/). Keep credentials in
its auth store or environment references, outside template source and Terraform
state. Verify tool calling and context limits against the selected model.

## Thin helpers

Browser Testing reserves 1 CPU / 4 GiB and Infrastructure reserves 500m CPU / 2 GiB.
Both retain 8 CPU / 16 GiB limits. Editor/File Browser services are disabled on these
two profiles. Browser retains Chrome, Playwright, and Desktop; Infrastructure retains
Terraform, Helm, kubectl, and Argo CD. New Infrastructure homes seed only the
cluster repository; existing user manifests are untouched. Persistent storage sizes are unchanged to
avoid unsupported volume shrink operations. Existing workspaces adopt template
changes at a deliberate update/rebuild; do not interrupt an active primary task.

The software, game, and electronics authoring workspaces retain their resources
and editing tools. Work that needs more guaranteed helper memory can adjust that
profile's reservation based on observed OOM or scheduling evidence.

## Completion-based cleanup

From the primary, inspect `coder templates list` and `coder list` before provisioning.
Reuse an appropriate healthy workspace when available. Create a disposable only
when isolation or required capabilities demand it:

```sh
hive-workspace create --task browser-check --name browser-check --template TEMPLATE_UUID
```

New disposables receive a two-hour autostop deadline, adjustable with
`--ttl-minutes` (15–1440). Active Coder connections extend the deadline, so close
idle connections when work ends. This is normal Coder autostop, not licensed
age-based dormancy. A detached process alone is not reliable activity evidence;
keep the Coder connection open while an unattended CLI is still working. Consult
[Coder activity detection](https://coder.com/docs/user-guides/workspace-scheduling).

Preserve code and validation evidence in the primary, verify the helper no longer
serves another task, then mark completion:

```sh
hive-workspace complete WORKSPACE_UUID --task browser-check --evidence /home/coder/projects/OWNER/REPO/EVIDENCE
hive-workspace cleanup WORKSPACE_UUID --task browser-check
```

The primary's scheduled reaper retries every five minutes while the primary is
running. It only considers signed receipts explicitly marked complete, stops the
workspace, waits for that exact stop build to succeed, then deletes it. Changed
identity, evidence, deployment, primary, or build retains the workspace. Old receipts
without a completion build checkpoint are retained. Reused, manually created,
persistent, primary, and active task workspaces are outside automatic deletion.
Do not bypass a refused cleanup with raw Coder deletion. Reused helpers may be
stopped when no longer in use, but remain available for later reuse.
