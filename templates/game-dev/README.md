# Game Development Workspace on Kubernetes

This Coder template isolates game and content work in a dedicated desktop image. Its persistent home
is sized for Unity Editors, projects, Blender assets, and generated caches.

## Runtime

- Profile: `game`
- Requests: 6 CPU and 16 GiB memory
- Limits: 12 CPU and 32 GiB memory
- Persistent home: 150 GiB
- No guaranteed GPU
- Image variant: `game` (includes Chrome for Unity sign-in; no Playwright, KiCad, or Obsidian)

Unity Hub, Blender 4.5 LTS, Coder Desktop, Claude Code, Codex, code-server, File Browser, and focused
C#/Unity/shader editor extensions are available. Unity licenses and Editors remain in the persistent
home volume across workspace restarts.

Google Chrome is the default browser for Unity Hub authentication in Coder Desktop. The image
registers the `unityhub://` callback so the browser can return to Hub after sign-in. Browser
automation and Playwright remain in `browser-testing`.

## Publish

```bash
coder templates push game-dev --directory templates/game-dev --yes
coder create --template game-dev game-01
```

Verify Desktop, Unity Hub login, Blender startup, editor extensions, repository bootstrap, and home
persistence. Perform production rendering or frame-time validation on GPU-enabled hardware.

Image changes take effect after the workspace-image workflow publishes the rebuilt `game` image
and its follow-up digest PR is merged. Then push this template and update/restart the workspace to
use the new image; pushing the template with the old digest does not install Chrome.
