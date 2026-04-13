# Quick Task: the hive template should have params that are set on template create to be changeable on workspace creation, does that make sense?

**Date:** 2026-04-13
**Branch:** main

## What Changed
- Converted 7 Terraform `variable` blocks to `data "coder_parameter"` blocks in the hive template so they appear in the Coder workspace creation UI and can be set/changed per workspace
- Parameters now surfaced in UI: task_id, task_prompt, repo_url, branch_name, vault_repo, dotfiles_uri, default_node_version, docker_socket
- All converted parameters are marked `mutable = true` (changeable on workspace restart)
- Added dropdown options for default_node_version (18, 20, 22, 24)
- Kept `anthropic_api_key` as a sensitive Terraform variable and `node_versions` as a list variable (not suited for `coder_parameter`)
- Updated all references from `var.*` to `data.coder_parameter.*.value`

## Files Modified
- `templates/hive/main.tf`

## Verification
- `terraform validate` passed successfully
