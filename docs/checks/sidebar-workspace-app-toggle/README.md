# Workspace app disclosure

Validated on 2026-10-25 in the reused Browser Testing workspace
`creator-direction-upgrade`, using Chrome and the real sidebar, collapsible,
general workspace, and theme components. Server actions and terminal transport
were fixture replacements; this was a component integration check, not a live
Coder deployment check.

At 1440×900 and 390×900:

- Workspace name, status, and chevron share one button. Clicking each toggles apps
  without navigation, starting a workspace, or remounting the existing terminal.
- Enter and Space toggle the same button, with `aria-expanded` and `aria-controls`.
- Mobile navigation stays open while toggling. Selecting Files opens its embedded
  window and dismisses mobile navigation without opening another browser tab.
- Helper workspaces behave the same way. Stopped workspaces with apps retain an
  explicit Open workspace link; terminal-only workspaces retain their existing link.
- No browser page errors occurred.

See `report.json` and the desktop/mobile screenshots. The two sidebar suites pass
all 36 tests. TypeScript and Biome checks pass.

Evidence was copied to the primary repository before removing task scratch data
from Browser Testing. The reused workspace remains available for its other work.
