# Unified workspace search

Add window and Cmd/Ctrl+K open the same search immediately, with terminals,
repositories, supported apps, agent tools, and commands across Coder workspaces.
There is no workspace-select dialog. Cmd/Ctrl+Option/Alt+F and the general
canvas's Cmd/Ctrl+Shift+N search alias have been removed. Stopped workspaces
appear with an explicit Start action; searching alone does not start them.

Tooltips share a 256px width, capped below the viewport width. Descriptions wrap
on the left above the shortcut footer, whose keybind remains aligned right.

## Validation

- `pnpm check`, `pnpm typecheck`, and `pnpm build` pass.
- All 2,043 Vitest tests pass, including progressive discovery, partial failures,
  start errors, duplicate-start protection, cancellation, and both palette entry points.
- Chromium validation in the existing Browser Testing workspace
  `creator-direction-upgrade` passes at 1440px, 1100px, and 390px widths.
- The fixture renders the real canvas, sidebar, command palette, and tooltip
  components with mocked Coder actions and terminal transport. It opens a named
  terminal, existing terminal, repository terminal, Files, VS Code, Desktop, and
  agent tools directly from search. It also checks explicit workspace start,
  workspace entry links, retired shortcuts, and arrow-key selection visibility.
- All 16 measured header/pane tooltips across Mac and Ctrl platforms are 256px
  wide. Long close labels wrap to three lines; footer alignment is preserved.

`report.json` and `tooltip-width-report.json` contain the measurements. Screenshots
show direct app search on desktop/mobile and short/long labels at the same tooltip
width. This is fixture validation, not a production Coder connection test.

The Browser Testing workspace was reused and retained running because it serves
another active task. Evidence is preserved here in the primary workspace.
