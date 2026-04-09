# M003: Shared Base Image & Obsidian Second Brain

## Vision
A single `hive-base` Docker image on Debian 13 (trixie) published to GHCR consolidates the duplicated ubuntu:24.04 base layers across all four Hive templates. Every template extends the base. Each workspace gets a KasmVNC desktop with Openbox — right-click launches Obsidian or a terminal without SSH. Obsidian autostarts with a git-backed vault (vault_repo per template), giving Claude a persistent second brain that syncs every 30 minutes across all workspaces. notesmd-cli enables headless vault access from scripts and agent prompts.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | S01 | high | — | ✅ | After this: `docker run --rm ghcr.io/<owner>/hive-base:latest claude --version` exits 0; `notesmd-cli --version` exits 0; GitHub Actions pushes the image on merge to main. |
| S02 | S02 | medium | — | ✅ | After this: all 4 template Dockerfiles are <20 lines each; `docker build` succeeds for all; `terraform validate` passes for all; 263 vitest tests still pass. |
| S03 | S03 | medium | — | ✅ | After this: create a workspace with vault_repo=<test-repo> → KasmVNC browser → Obsidian open with vault loaded → right-click shows app menu → `notesmd-cli search ~/vault test` returns results → 30min later vault changes pushed to GitHub. |
