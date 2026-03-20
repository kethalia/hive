# Workspace Benchmarks

This document describes how to measure and compare workspace cold-start vs warm-start times using Coder's prebuilt workspace pools.

## Prerequisites

- **Coder Premium license** — prebuilt workspaces require a Premium (or Enterprise) license. Without it, the `prebuilds` block in templates is ignored.
- Coder CLI installed and authenticated (`coder login`)
- Templates pushed: `hive-worker`, `hive-verifier`

## Measurement Instructions

### Cold Start (No Prebuilds)

Temporarily disable prebuilds by setting `instances = 0` in the template preset, then measure:

```bash
# Ensure no prebuilt workspaces are available
coder templates push hive-worker --yes  # with prebuilds.instances = 0

# Measure cold start
time coder create my-bench-worker \
  --template hive-worker \
  --parameter task_id=bench-001 \
  --parameter task_prompt="benchmark test" \
  --parameter repo_url="https://github.com/example/repo" \
  --yes

# Clean up
coder delete my-bench-worker --yes
```

### Warm Start (With Prebuilds)

Re-enable prebuilds (`instances = 2` for worker, `instances = 1` for verifier), wait for the pool to fill, then measure:

```bash
# Push template with prebuilds enabled
coder templates push hive-worker --yes  # with prebuilds.instances = 2

# Wait for prebuilt workspaces to appear
coder list --all | grep prebuilds

# Measure warm start (claims a prebuilt workspace)
time coder create my-bench-warm \
  --template hive-worker \
  --parameter task_id=bench-002 \
  --parameter task_prompt="benchmark test" \
  --parameter repo_url="https://github.com/example/repo" \
  --yes

# Clean up
coder delete my-bench-warm --yes
```

## Expected Time Ranges

| Scenario | Expected Duration | Notes |
|----------|------------------|-------|
| Cold start (worker) | 30–90 seconds | Includes Docker pull, container create, agent startup |
| Cold start (verifier) | 30–90 seconds | Similar to worker |
| Warm start (worker) | 2–10 seconds | Claims pre-created workspace, skips provisioning |
| Warm start (verifier) | 2–10 seconds | Claims pre-created workspace, skips provisioning |

Actual times depend on Docker image size, registry proximity, and host resources.

## Configuring Prebuild Pool Size

Pool sizes are configured in each template's `main.tf` via the `coder_workspace_preset` resource:

```hcl
data "coder_workspace_preset" "default" {
  # ...
  prebuilds {
    instances = 2  # Number of warm workspaces to keep ready
  }
}
```

**Current defaults:**
- `hive-worker`: 2 instances (higher task throughput demand)
- `hive-verifier`: 1 instance (verification runs less frequently)

Increase pool size if workspaces are claimed faster than they can be replenished. Monitor via Coder's Prometheus metrics:

- `coderd_prebuilt_workspaces_desired` — target pool size
- `coderd_prebuilt_workspaces_running` — currently available
- `coderd_prebuilt_workspaces_created_total` — total created
- `coderd_prebuilt_workspaces_claimed_total` — total claimed

## Verifying Prebuild Status

```bash
# List prebuilt workspaces
coder list --all | grep prebuilds

# Or via the Coder dashboard: filter by owner:prebuilds
```
