# M009: Multi-Target Vault Sync

## Vision
Fix sync-vault.sh to copy vault skills and context files (AGENTS.md, CLAUDE.md) to three independent directories (~/.claude/, ~/.agents/, ~/.pi/agent/) with direct copies — no symlinks. Remove the GSD agent skills symlink logic entirely.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | S01 | low | — | ⬜ | Run sync-vault.sh and see skills + AGENTS.md + CLAUDE.md in all 3 directories (~/.claude/, ~/.agents/, ~/.pi/agent/), no symlinks, stale cleanup works per-directory |
