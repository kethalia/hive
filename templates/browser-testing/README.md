# Browser Testing Workspace on Kubernetes

This Coder template is the only Hive workspace profile that contains Google Chrome and configures
Playwright for Claude Code and Codex. It isolates browser state, screenshots, traces, downloads, and
headed inspection from implementation and orchestration workspaces.

## Runtime

- Profile: `browser`
- Image variant: `browser`
- Requests: 4 CPU and 8 GiB memory
- Limits: 8 CPU and 16 GiB memory
- Persistent home: 50 GiB
- Desktop: XFCE through KasmVNC

The image contains the common CLI baseline, Chrome, and the desktop runtime. It deliberately excludes
Unity, Blender, KiCad, and Obsidian. The profile adds Playwright MCP configuration only while this
workspace is active.

## Publish

```bash
coder templates push browser-testing --directory templates/browser-testing --yes
coder create --template browser-testing browser-test-01
```

Verify Chrome startup in Desktop, Claude and Codex Playwright MCP discovery, the
`browser-screenshot` and `browser-html` helpers, code-server, File Browser, and persistence across a
stop/start cycle.
