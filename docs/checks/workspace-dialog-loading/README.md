# Workspace dialog loading

Opening Agents or Coder workspace management previously let their deferred imports
reach the page's Suspense boundary, replacing the loaded canvas with “Loading
workspace…”. Each dialog now owns its loading fallback, keeping existing windows
visible and their layout effects mounted. The Agents loading dialog can be dismissed
before its module arrives.

The two regression cases use Next's actual App Router dynamic loader and deliberately
pending module imports under the same page-level fallback. Both fail before the fix
and pass afterward. They cover terminal DOM identity, draft preservation, layout-effect
lifetime, dismissal before loading completes, no late reopening, and reopening after
the module has loaded. All 34 focused canvas, pane, command, and agent-dialog tests
pass, as do typecheck and Biome checks.

Chromium validation ran at 1440px and 390px in the reused Browser Testing workspace
`creator-direction-upgrade`. The fixture bundles the actual workspace and dialogs,
uses an App Router-equivalent lazy loader with manually delayed dialog modules, and
mocks Coder actions and terminal transport. Both dialogs were opened, dismissed while
loading, reopened before the import completed, then opened again after loading.
The terminal retained its DOM, unsent command, and single mount with zero layout-effect
cleanups. The loaded dialogs retained keyboard focus; Escape dismissed them. No page
fallback or browser runtime error appeared. See `report.json` and the loading-state
screenshots. This validates client lifecycle behavior, not a production Coder session.

Evidence is preserved here. The reused specialist workspace remains running because
it serves another active task; only this validation's temporary files were removed.
