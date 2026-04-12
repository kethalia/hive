# Quick Task: Adopt Coder Registry Modules & Remove web3-dev Template

**Date:** 2026-04-12
**Branch:** main

## What Changed

Replaced custom scripts with Coder registry modules across both ai-dev and hive templates, and removed the web3-dev template entirely.

### Modules Adopted

| Module | Version | Replaces |
|--------|---------|----------|
| `coder/claude-code` | 1.1.0 | `claude-install.sh` + manual `coder_app`/`coder_script` blocks |
| `coder/kasmvnc` | 1.3.0 | `browser-serve.sh` (104 lines) + `coder_app.browser_vision` |
| `thezoker/nodejs` | 1.0.13 | `tools-nvm.sh` (51 lines x 2 templates) |
| `coder/dotfiles` | 1.4.1 | Dotfiles clone block in `init.sh` |
| `coder/coder-login` | 1.0.15 | Nothing (new -- auto-authenticates `coder` CLI in workspaces) |
| `anomaly/tmux` | 1.0.4 | Nothing (new -- adds session persistence + TPM) |

### Templates

- **ai-dev**: Refactored to use all 6 modules. Kept: code-server, filebrowser, github-upload-public-key, git-commit-signing, git-config, git-clone-vault. Retained tools-web3.sh, tools-shell.sh, tools-node.sh, tools-ci.sh, tools-ai.sh, tools-browser.sh, symlinks.sh.
- **hive**: Refactored to use all 6 modules. Same retained scripts minus tools-web3.sh.
- **web3-dev**: Removed entirely (separate base image, inline scripts, not built on hive-base).

### Key Decisions

- **kasmvnc**: `desktop_environment = "manual"` since openbox + xstartup are baked into hive-base Docker image. Port set to 6080 to match existing setup.
- **claude-code v1.1.0**: Module doesn't support `model`/`system_prompt` params -- those stay as env vars on the agent block for ai-dev.
- **dotfiles**: For hive (variable-based), `dotfiles_uri` passed directly. For ai-dev, module creates its own `coder_parameter` (removed the old one).

## Files Modified
- `templates/hive/main.tf` -- removed 3 script resources + 1 app, added 6 modules
- `templates/ai-dev/main.tf` -- removed 3 script resources + 2 apps + 1 parameter, added 6 modules
- `templates/hive/scripts/init.sh` -- removed dotfiles clone block
- `templates/ai-dev/scripts/init.sh` -- removed dotfiles clone block

## Files Deleted
- `templates/hive/scripts/claude-install.sh`
- `templates/hive/scripts/browser-serve.sh`
- `templates/hive/scripts/tools-nvm.sh`
- `templates/ai-dev/scripts/claude-install.sh`
- `templates/ai-dev/scripts/browser-serve.sh`
- `templates/ai-dev/scripts/tools-nvm.sh`
- `templates/web3-dev/` (entire directory)

## Verification
- `terraform fmt` -- both templates formatted clean
- `terraform init -upgrade` -- all modules downloaded successfully
- `terraform validate` -- both templates pass validation
- Net script deletion: ~310 lines of bash removed, replaced by 6 module declarations (~60 lines of HCL)
