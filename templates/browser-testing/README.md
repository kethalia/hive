# Browser Testing Workspace on Kubernetes

This Coder template is the only Hive workspace profile that contains Google Chrome and configures
Playwright for Claude Code and Codex. It isolates browser state, screenshots, traces, downloads, and
headed inspection from implementation and orchestration workspaces.

## Runtime

- Profile: `browser`
- Image variant: `browser`
- Requests: 1 CPU and 4 GiB memory
- Limits: 8 CPU and 16 GiB memory
- Persistent home: 50 GiB
- Desktop: XFCE through KasmVNC

The image contains the common CLI baseline, Chrome, and the desktop runtime. It deliberately excludes
Unity, Blender, KiCad, and Obsidian. The profile adds Playwright MCP configuration only while this
workspace is active. Editor and File Browser services are disabled; use Desktop for browser
inspection and terminal/SSH to run checks.

## Publish

```bash
coder templates push browser-testing --directory templates/browser-testing --yes
coder create --template browser-testing browser-test-01
```

Verify Chrome startup in Desktop, Claude and Codex Playwright MCP discovery, the
`browser-screenshot` and `browser-html` helpers, and persistence across a
stop/start cycle.
