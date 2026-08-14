# Game Development Workspace on Kubernetes

This Coder template isolates game and content work from the general software workspace while reusing
the same cached base image. Its persistent home is sized for Unity Editors, projects, Blender assets,
and generated caches.

## Runtime

- Profile: `game`
- Requests: 6 CPU and 16 GiB memory
- Limits: 12 CPU and 32 GiB memory
- Persistent home: 150 GiB
- No guaranteed GPU

Unity Hub, Blender 4.5 LTS, Coder Desktop, Claude Code, Codex, code-server, File Browser, and focused
C#/Unity/shader editor extensions are available. Unity licenses and Editors remain in the persistent
home volume across workspace restarts.

## Publish

```bash
coder templates push game-dev --directory templates/game-dev --yes
coder create --template game-dev game-01
```

Verify Desktop, Unity Hub login, Blender startup, editor extensions, repository bootstrap, and home
persistence. Perform production rendering or frame-time validation on GPU-enabled hardware.
