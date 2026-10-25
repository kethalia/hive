# hive-orchestrator

## 2.29.0

### Minor Changes

- 5f68025: Keep terminal and project creation inside a nested command launcher, with searchable categories, inline name prompts, animated Back navigation, and keyboard controls.

## 2.28.2

### Patch Changes

- 473d38f: Replace full-edge resize highlights with subtle centered grips while preserving pointer and keyboard resizing.

  Keep directional focus on the adjacent window when fractional column widths and scrolling cause tiny edge-rounding differences.

  Use Cmd/Ctrl+Arrow to focus windows and Cmd/Ctrl+Option/Alt+Left/Right to switch numbered workspaces, with matching keyboard help.

## 2.28.1

### Patch Changes

- f757b20: Improve launcher relevance across tools, apps, sessions, projects, and commands. Prioritize names, order groups by their best match, support common aliases and limited typos, and exclude unrelated scattered-letter matches.

## 2.28.0

### Minor Changes

- 1d9c8cd: Replace the sidebar with a grouped Cmd/Ctrl+K launcher for sessions, projects, Files, VS Code, Desktop, and Hive tools. Add named terminal creation and GitHub organization/repository cloning. Open Agents, Settings, Diagnostics, Logs, Templates, and Coder management as persistent, resizable workspace windows, reusing existing windows across workspaces.

  Add the previous-workspace window command and Cmd/Ctrl+W to close the current Hive workspace, with a browser-safe alternative. Closing views preserves their tmux sessions.

## 2.27.1

### Patch Changes

- aa80d7a: Remove the separate Arrange windows screen and consolidate layout shortcuts and their enable/disable setting in keyboard help, opened with Cmd/Ctrl+? or Cmd/Ctrl+/.

  Keep the sidebar over the workspace without resizing panes, replace the bottom slider with reliable horizontal trackpad scrolling, and add Cmd/Ctrl+Left/Right window focus shortcuts.

  Use Command on macOS and Control on Windows/Linux for layout shortcuts, migrate previous modifier presets, and move pane actions to Cmd/Ctrl+Alt+Period to avoid conflicts.

## 2.27.0

### Minor Changes

- dc4dc00: Add resizable Grid and Strip layouts with live drag previews, column stacking/tabs/pins, floating windows and documented keyboard controls. Preserve terminal and app instances across layout and board changes.

  Remove the legacy per-workspace terminal UI and unused navigation code. Route notifications to an existing general-workspace window or a new board, retaining only redirects and a read-only saved-layout importer for compatibility.

## 2.26.5

### Patch Changes

- 1fc022d: Combine each workspace's sidebar name, status, and chevron into one button that expands or collapses its apps.
- 5de70d4: Reuse workspace, repository, terminal, and agent discovery across panels. Refresh cached results in the background through authenticated GET endpoints, cache expensive scans in Valkey with a bounded local fallback, and inspect template archives only when needed.

## 2.26.4

### Patch Changes

- 29940c5: Show search loading feedback alongside partial results and treat a missing Hive terminal socket as an empty session list instead of showing a false retry action.

## 2.26.3

### Patch Changes

- f9b86a9: Only show repositories whose name or path contains the search text, ignoring case and surrounding whitespace. Prevent fuzzy matching against workspace metadata from including unrelated repositories.
- 5bb40e8: Keep the loaded workspace visible when opening Agents or Coder workspace management by showing loading feedback inside each dialog.

## 2.26.2

### Patch Changes

- cc53cd3: Unify Add window and Cmd/Ctrl+K search across workspace terminals, repositories, apps, and agent tools, removing the workspace selection step and alternate search shortcut. Give tooltips a shared width with wrapping descriptions above their shortcut footer.

## 2.26.1

### Patch Changes

- 48da71e: Restore repository and named-terminal actions in shared workspace search, keep keyboard-selected commands clear of scroll indicators, show Coder workspaces as responsive cards, align terminal control hover states, and place shortcut keys in right-aligned tooltip footers.

## 2.26.0

### Minor Changes

- 491d2fc: Replace the workspace list landing page with a shared canvas for terminals, Files, VS Code, and Desktop from multiple Coder workspaces. Open sidebar tools inside Hive, preserve numbered boards across reloads, and keep environment management available from the canvas menu.

  Unify workspace header and terminal audio controls with matching square buttons, a disconnected microphone X icon, and themed tooltips showing working, platform-specific keyboard shortcuts for the focused pane.

  Preserve mobile keyboard sizing, scoped file-link actions, and explicit terminal reconnects in the shared workspace canvas.

  Allow mobile scrolling in the window picker, open-window tabs, and workspace-management dialog while keeping background scrolling locked.

  Resolve file-window targets to absolute paths before saving them, and keep mobile workspace header controls below the device safe area.

  Preserve distinct file targets when importing legacy Files panes and reattach canvas size observation when responsive layouts replace the canvas element.

### Patch Changes

- d21aa2d: Use a compact, readable font-size control and remember font size separately for each terminal session, including mobile controls.
- 66f0b89: Keep workspace table actions on one line so opening the sidebar does not increase row heights.

## 2.25.0

### Minor Changes

- 05bffd7: Reduce helper workspace reservations and services, add autostop and completed-disposable cleanup, and update native agent launchers with optional OpenCode support.
- 0917d12: Focus sidebar navigation on workspaces and helpers, remove repository and session trees, and move terminal font sizing into More actions.

## 2.24.0

### Minor Changes

- bae3ca0: Add workspace agent setup diagnostics, optional local session tracking, and native conversation recovery. Configure read-only Coder MCP tools and TypeScript code intelligence in the software profile without blocking terminal login.

### Patch Changes

- d0b49aa: Release all four application images with the Node.js 22.23.4 security update.
  The web image also includes the patched Next.js 16.4.1 runtime.

## 2.23.0

### Minor Changes

- 5b9acea: Add pane-header microphone and speaker menus with independent connect, pause, stop, and hold-to-pause controls. Notify users when another connected pane produces sound, with actions to focus that pane or listen to its current reply without moving. Simplify workspace headers and pane action menus.

## 2.22.2

### Patch Changes

- 23960b3: Move Diagnostics into the sidebar footer directly above Settings.

## 2.22.1

### Patch Changes

- d0420c4: Fix scrolling on the terminal diagnostics page so workspace details remain reachable on desktop and mobile.

## 2.22.0

### Minor Changes

- a1e47c1: Add a Settings page with separated notification sections and installed app version checks and updates. Replace the sidebar settings disclosure, notification link, refresh control, and update shortcut with a direct Settings link. Preserve push subscriptions when updating.

## 2.21.6

### Patch Changes

- 7d0b0cf: Remove terminal compose panels, controls, shortcuts, and session locks while preserving direct text paste and file uploads. Keep the keyboard shortcut dialog in sync with active bindings and show platform alternatives, browser fallback chords, native paste, and workspace navigation aliases.

## 2.21.5

### Patch Changes

- c27be33: Show terminal file-drop feedback and bottom-right clipboard toasts, add numbered workspace shortcuts, and reduce notification and workspace restoration latency by preserving live terminals and batching Git pane authorization.

## 2.21.4

### Patch Changes

- e83b320: Open agent notifications in the existing workspace board when its session is already present, or in a freshly authorized standalone terminal otherwise. Recover older Git notification links, prefer the matching app window, and write alerts as short messages.

## 2.21.3

### Patch Changes

- 6911537: Show the project and readable session name in agent notifications, with the workspace on a separate line. Keep opaque terminal IDs for notification routing instead of displaying them as task locations.

## 2.21.2

### Patch Changes

- ccc2ad7: Identify agent notification callbacks with a Hive user-agent so Cloudflare accepts their requests instead of rejecting Python's default client signature.

## 2.21.1

### Patch Changes

- ac1ec7f: Fix iOS push delivery and workspace notification hook installation. Improve the notification settings layout and setup feedback, and remove redundant app-name prefixes from notification titles.

## 2.21.0

### Minor Changes

- 7efebce: Add mobile and desktop PWA push alerts for Codex and Claude Code questions, approvals, and ready reports, with Claude failure, template result, and token-expiry alerts. Add per-device preferences, CRT sound previews, workspace hook setup and revocation, secure callback delivery, notification badges, and terminal deep links.

### Patch Changes

- c3c5097: Fix template descriptions overlapping table columns, add a confirmed Push all action with independent progress, and restore desktop and mobile scrolling when multiple push panels are open. Keep queued and active pushes pending until their actual result is known instead of reporting log-wait timeouts as failures. Reconnect interrupted streams without enqueuing another job, and coalesce status scans after bulk pushes. Drain final local output before reporting queue completion.
- 2a17d10: Show pane actions in an anchored dropdown on desktop while retaining the bottom drawer on mobile. Let the More button toggle the menu and preserve terminal focus selected by pane actions.
- Updated dependencies [7efebce]
  - @hive/db@0.3.0

## 2.20.8

### Patch Changes

- 891bdba: Require a dedicated AUTH_SERVICE_SECRET for internal auth-service requests, authenticate the web and terminal clients, and reject missing or invalid service credentials before accessing sessions or Coder tokens. Provision the same 64-hex secret in all three services before rollout, update clients first, then enable auth-service enforcement.
- 5c71ff5: Bound terminal paste uploads to 20 MiB total and 10 MiB per file, reject excess concurrent requests before reading their bodies, and transfer files sequentially with cancellation and timeout cleanup.
- 03ab163: Require explicit microphone approval for each terminal voice call and add a Stop microphone control. Ordinary terminal input no longer authorizes recording.
- 07d5177: Use protected host-only production session cookies and a new signing purpose, reject duplicate cookies, and authenticate separate terminal/audio/status transports with short-lived request-bound tickets. Existing users must sign in once after a coordinated web/terminal rollout; legacy cookie domains are deletion targets only.
- a815cba: Refresh native Claude Code from the latest channel on every workspace startup alongside Codex, with bounded update attempts and offline fallback. Document the owner's accepted latest AI tool policy across all workspace profiles.
- 333b5b7: Restrict managed desktop listeners to loopback behind owner-only Coder apps. Prevent KasmVNC's wildcard UDP binds, disable raw VNC/X11 TCP, and verify the bind guard before starting the backend. Bundle its source with templates so existing pinned desktop images can compile it securely; newer images supply the prebuilt guard.
- 1aaacee: Allow Retry terminal connection to start a fresh authorized attempt after a final failure, while keeping automatic reconnects stopped for those failures.
- 714a7a1: Use held touch drags for tmux selection on mobile and copy on release, without native selection handles. Tie remote clipboard writes to a selection gesture or an explicit Copy action.
- 57aadc9: Handle SSH upload stream errors so failed terminal paste uploads cannot crash the Hive web process, and clear transfer timeouts on failure.
- 4190eae: Remove automatic tmux snapshots and command restoration from workspace images. Running terminal sessions still survive browser disconnects.
- c76c9e0: Keep workspace-tab keyboard navigation working when saved board keys contain quotes, backslashes, or other CSS selector characters.
- 6db9648: Keep automatic owner-level Coder CLI authentication in the primary software workspace. Specialist profiles clear inherited and persisted Hive owner credentials before their agent starts, while retaining workspace agent and GitHub authentication.
- f37f39d: Remove the unpinned Coder shell installer from the production web image. Install only the architecture-specific release archive after checking its pinned SHA-256 digest, and reject unsupported or missing target architectures.
- 2218cb3: Guard automatic specialist cleanup through a software-only wrapper with signed creation receipts, recorded task/evidence integrity checks, fresh UUID validation, and stopped-before-delete ordering. Completion remains the trusted primary agent's decision, an explicitly accepted risk. Require explicit template updates when rolling out the helper and agent instructions.

  Hash preserved evidence incrementally during completion and cleanup so large files do not need to fit in memory.

- 27f7301: Verify workspace image downloads before extraction or installation, and replace the remote Claude installer with a pinned native release.
- a3a4039: Retire same-origin workspace proxy responses and open workspace tools through authenticated Coder app URLs outside Hive's session-cookie scope. Block camera and microphone access in embedded tools while preserving downloads, clipboard integration, pointer lock, and fullscreen. App domains overlapping Hive cookies must be reconfigured before tools can open.
- 1da9256: Release the updated Kubernetes workspace image digests with the bundled Coder templates.
- 0b65e1f: Release the updated Kubernetes workspace image digests with the bundled Coder templates.
- 6a4b3df: Release the updated Kubernetes workspace image digests with the bundled Coder templates.
- Updated dependencies [891bdba]
- Updated dependencies [07d5177]
  - @hive/auth@1.0.4

## 2.20.7

### Patch Changes

- a065eeb: Keep active voice calls connected across workspace and window changes, pausing microphone input and speaker playback in unfocused panes and resuming them when focused. Recover suspended browser audio contexts and heartbeat timers, and discard microphone and speaker frames queued before resuming focus.
- 8a6fa38: Release the updated Kubernetes workspace image digests with the bundled Coder templates.

## 2.20.6

### Patch Changes

- 92935af: Keep terminal voice calls connected through brief audio backpressure by dropping late PCM, reserving bounded capacity for controls, and retrying workspace relay controls when the broker queue is full.

## 2.20.5

### Patch Changes

- 96e09ec: Release the workspace images containing per-terminal voice ownership with the
  bundled Coder templates. Idle views observe calls without reserving audio, and
  only an explicitly claimed call owns its virtual devices. Push the updated
  template and update/restart existing workspaces to install the new helper.

## 2.20.4

### Patch Changes

- c613a31: Allow simultaneous voice calls in separate terminal sessions using each session's
  virtual microphone and speaker devices. Idle views no longer reserve workspace
  audio, and calls claim ownership before requesting microphone permission so a view
  left open on another device cannot interrupt the active call. Compose and touch
  Enter controls arm voice for their target terminal, including while the audio
  bridge loads. Each interaction permits only one claim attempt so earlier calls
  cannot reclaim a new call started on another device.

  Deploy matching web, terminal proxy, and rebuilt workspace images, then restart
  workspaces to enable the new native audio ownership protocol.

- 01aa39c: Release the updated Kubernetes workspace image digests with the bundled Coder templates.

## 2.20.3

### Patch Changes

- 0a157c3: Fix native Codex voice in workspace images by exposing Debian's ALSA plugins at the
  path used by Codex's bundled audio library. Requires the rebuilt workspace image
  and a workspace restart.
- a7a6c44: Keep terminal voice calls attached to the pane that started them. Prevent background
  panes and overlapping permission requests from competing for the microphone, ignore
  retired audio callbacks, and retain call ownership while native capture is paused.
  The native capture lifecycle fix requires the rebuilt workspace image and a restart.

## 2.20.2

### Patch Changes

- 2ba2e28: Preserve local repository manifests across workspace starts and add an explicit task worktree lifecycle
  with grouped checkouts, committed-history retention, and daily cleanup of completed idle tasks.

## 2.20.1

### Patch Changes

- 8d74cb0: Restore browser fullscreen on Ctrl/Cmd+Enter and lock Escape when the browser supports keyboard locking.

## 2.20.0

### Minor Changes

- 4232820: Add a mobile file picker for uploading PDFs and other files to the active terminal workspace. Show clipboard and upload progress, success, and failure feedback with loading controls and toasts. Keep Escape available to terminal programs while Ctrl/Cmd+Enter toggles app fullscreen.

## 2.19.1

### Patch Changes

- f5719f1: Release the updated Kubernetes workspace image digests with the bundled Coder templates.

## 2.19.0

### Minor Changes

- b6d3273: Bridge browser microphone and speaker audio to per-terminal virtual workspace
  devices so native Codex `/voice` works without a separate voice bar or session
  picker. Automatically request permission on capture, bound media queues, and
  release audio on terminal hiding or disconnect. Enforce one microphone owner
  across sessions and, with Web Locks, same-origin tabs and PWA windows. Requires the updated hive-base
  workspace image and a new terminal session.

## 2.18.1

### Patch Changes

- a284cd7: Allow explicit browser voice origins for deployments with multiple proxy hostnames while retaining strict forwarded-origin validation.

## 2.18.0

### Minor Changes

- 13f5e45: Add opt-in Codex browser voice with session selection, WebRTC microphone and spoken audio, mute/end controls, and authenticated workspace signaling. Enable the experimental prototype with HIVE_CODEX_VOICE_ENABLED=true.

### Patch Changes

- 9cc9bfb: Retry transient Git configuration lock contention during workspace alias and credential-helper initialization so concurrent startup scripts do not leave a working workspace marked unhealthy.

## 2.17.17

### Patch Changes

- 17e09ea: Refresh the Codex CLI from latest on workspace startup so persistent installations do not silently stay behind the independently updated background server.

## 2.17.16

### Patch Changes

- 356d011: Bound daily workspace build-cache retention and right-size the software profile CPU reservation while preserving burst capacity.

## 2.17.15

### Patch Changes

- b8d5516: Validate the installed Codex runtime with behavioral sandbox probes without CLI version or helper-hash allowlists, so readiness works with latest releases.

## 2.17.14

### Patch Changes

- ba9bba6: Expose Codex's bundled bubblewrap on PATH when no bwrap command exists, preventing the missing-helper startup warning while preserving existing commands.

## 2.17.13

### Patch Changes

- 1b60cf0: Enable the validated Codex AppArmor policy in workspace templates and strengthen the on-demand sandbox readiness checks.

  Pin patched proxy-addr and tinypool transitive dependencies so the critical dependency audit passes on Node 22.

## 2.17.12

### Patch Changes

- 1c16900: Fix workspace provisioning across all five templates by exposing the manual sandbox diagnostic as a terminal app instead of an invalid triggerless Coder script.

## 2.17.11

### Patch Changes

- bbe2c9e: Update global agent instructions across all workspace profiles to require Conventional Commit titles and ready-for-review PRs when work is complete. Automatically stop and delete disposable specialist workspaces created for a completed task after preserving results; retain reused or persistent workspaces unless deletion is explicitly confirmed, and protect active tasks and the primary workspace.
- 5948f20: Add a credential-free restricted Codex sandbox diagnostic and opt-in, node-scoped AppArmor policy selection to the shared workspace scaffold.

## 2.17.10

### Patch Changes

- 688712c: Reduce infrastructure workspace CPU reservations to one core so maintenance workspaces can schedule on nodes with limited unreserved capacity, while preserving their eight-core burst limit.

## 2.17.9

### Patch Changes

- e15ca66: Schedule bounded weekly npm cache maintenance in all bundled Coder workspace profiles.

## 2.17.8

### Patch Changes

- 2abd33d: Restore keyboard focus to the selected terminal when switching Hive workspaces, including when the terminal becomes ready after the switch.

## 2.17.7

### Patch Changes

- bda0b26: Preserve recently opened terminal surfaces and connections across workspace navigation. Wait for upstream PTY readiness before accepting input, probe foreground connection health, preserve terminal surfaces during clone credential refresh, and bound suspended browser attachments and queued proxy output. Gracefully close sockets during proxy restarts.

## 2.17.6

### Patch Changes

- d6623f8: Open terminal web-link menus reliably on touch by delaying link detection until finger release, preserving the original touch target while the finger is down.

## 2.17.5

### Patch Changes

- 2eb9289: Prevent hidden workspaces from intercepting mobile terminal taps or reclaiming the active window through stale selection events.

## 2.17.4

### Patch Changes

- 143422a: Fix mobile terminal link taps and native text selection, replace paged controls with one horizontally scrollable row of exact key combinations, apply highlighted modifiers to mobile keyboard input, complete tapped file checks without waiting for hover, and update Next.js to address its critical next/og vulnerability.

## 2.17.3

### Patch Changes

- 7ad3469: Show immediate loading feedback when hovering or tapping terminal file links, then open file actions as soon as validation finishes. Keep slow touch requests active and prevent delayed validation results from reopening dismissed menus.

## 2.17.2

### Patch Changes

- 117e199: Share pending terminal file checks and briefly cache their results so redraws do not repeatedly validate the same path and prevent file menus from opening. Cover relative paths, file URLs, and embedded terminal links.

## 2.17.1

### Patch Changes

- 0bccacd: Make terminal link menus compact on desktop and keep them open while moving the cursor to an action. Preserve larger touch targets, including on hybrid devices, and prevent repeated hover events from moving the menu. Dismiss menus when terminal scrolling, resizing, or output invalidates their linked content, including hidden OSC 8 destinations. Keep pending hovers separate from open menus and clear stale link tracking when a menu closes.

  Only offer terminal file links after confirming that the target is an existing file or directory in the session workspace. Ignore slash-separated prose and failed or stale filesystem checks.

## 2.17.0

### Minor Changes

- 902eb93: Add terminal action menus on hover, click, and touch. File paths can be copied, downloaded, or opened in a new Files window in the current or a new numbered workspace. URLs can be copied or opened in the browser.

## 2.16.0

### Minor Changes

- 570cc5a: Paste multiline prompts directly into native terminal applications without opening Compose or automatically submitting. Open terminal links in the local browser and support Codex/tmux clipboard copying, including native mobile selections and copy retries. Add question controls and a complete modifier-key keyboard for mobile/tablet shortcuts, improve terminal contrast, and forward clipboard and extended-key capabilities through tmux.

## 2.15.2

### Patch Changes

- ea42a7e: Include Chrome and desktop authentication handlers in the game workspace image for Unity Hub sign-in, and document the game profile's browser support.
- ea42a7e: Upgrade Next.js to 16.3.3 to address critical security advisories GHSA-p293-qw3h-jr36 and GHSA-2xp9-vwfh-vxw4.

## 2.15.1

### Patch Changes

- d79cf42: Register the Cloudflare API MCP server during startup across all Coder workspace templates so Codex can find it for OAuth login, while preserving existing user configuration.

## 2.15.0

### Minor Changes

- 10cba9d: Remove the retired technical interview workspace template and its Hive catalog and profile entries.

## 2.14.0

### Minor Changes

- 58c347b: Add an isolated browser-capable technical interview workspace with anonymous repository bootstrap,
  credential-safe Claude launch, pinned Codex, Playwright MCP, Bun and pnpm tooling, readiness helpers,
  and built-in Hive template integration.

## 2.13.4

### Patch Changes

- 126052e: Teach every Coder workspace how to route capability-specific work and refresh Hive-managed global
  agent context when a workspace template is updated.

## 2.13.3

### Patch Changes

- a696ad6: Initialize profile guidance for both Codex and Claude in fresh Kubernetes workspaces while preserving
  existing user-owned agent context.

## 2.13.2

### Patch Changes

- 120a518: Release the updated Kubernetes workspace image digests with the bundled Coder templates.

## 2.13.1

### Patch Changes

- db50a0a: Release the updated Kubernetes workspace image digests with the bundled Coder templates.

## 2.13.0

### Minor Changes

- 4c1c12e: Give Infrastructure its own headless workspace image with checksum-pinned Terraform, kubectl, Helm,
  and Argo CD clients while keeping those tools out of the general and desktop profiles.

## 2.12.1

### Patch Changes

- c068d54: Ensure fresh non-browser Coder workspaces complete startup by creating the managed Codex
  configuration before applying its permissions.

## 2.12.0

### Minor Changes

- 14303fc: Make `ai-dev-k8s` the persistent development and orchestration workspace, retire the standalone
  orchestrator from template publishing and workspace launch flows, and preserve terminal-only support
  for existing orchestrator workspaces.

## 2.11.2

### Patch Changes

- c5c44fe: Include every conditional SWC helper export in the Next.js standalone image so the web server
  starts correctly on the production Node.js runtime.

## 2.11.1

### Patch Changes

- 7b0f8fe: Update the web, authentication, terminal, and migration runtime dependency chains to patched
  Next.js, Prisma, Undici, and WebSocket releases. Keep the UI scaffolding CLI out of production
  dependencies and make CI enforce the root application typecheck.
- Updated dependencies [7b0f8fe]
  - @hive/db@0.2.1

## 2.11.0

### Minor Changes

- f34c01f: Retire the asynchronous Tasks workflow and task-specific Coder template in favor of interactive,
  profile-driven workspaces. Add authenticated start, stop, and exact-name-confirmed delete controls,
  plus the database migration that removes legacy task records and task-owned workspace metadata.
- 6cedff9: Add Kubernetes-only Orchestrator, Software, Browser Testing, Game, Electronics, and Infrastructure
  Coder workspace profiles with capability-specific images, resources, tooling, repository bootstrap,
  interactive guidance, and shared scaffold synchronization. Expose each profile's runtime surface in
  Hive and hide applications that its template does not provision.

### Patch Changes

- Updated dependencies [f34c01f]
  - @hive/db@0.2.0

## 2.10.8

### Patch Changes

- 08013ff: Route shifted terminal paste shortcuts through the multiline compose flow and preserve bracketed paste when sending composed text.

## 2.10.7

### Patch Changes

- 0083d09: Increase Kubernetes development workspaces to reserve 6 CPU and 16 GiB of memory,
  with limits of 12 CPU and 32 GiB of memory.

## 2.10.6

### Patch Changes

- 33fdbbd: Update the workspace template to use the latest hive-base image.

## 2.10.5

### Patch Changes

- a66ed2d: Replace unverified domain skills and third-party KiCad MCP tooling with a pinned,
  official skill baseline for React, UI review, Cloudflare, and application security,
  plus OpenAI's official GitHub plugin for Codex. Remove unused workspace creation
  parameters and use fixed template defaults.

## 2.10.4

### Patch Changes

- bae6c89: Ship the latest AI development workspace template with the updated hive-base image digest.

## 2.10.3

### Patch Changes

- d978aff: Add KiCad and shared Claude/Codex electronics-design tooling to the workspace template.

## 2.10.2

### Patch Changes

- f74efe7: Store Codex plugin manifests at upload-safe template source paths so Coder template pushes include them.

## 2.10.1

### Patch Changes

- 83153ee: Add Unity and Blender game-development tooling and update the workspace templates.

## 2.10.0

### Minor Changes

- 20c81ee: Add accessible mobile and tablet sidebar gestures, direct pane action drawers, and swipe-reveal session actions.

## 2.9.1

### Patch Changes

- 64e4139: Prevent terminal and Git workspace windows from crashing during concurrent socket teardown and resize activity, and add authorized live session event logs to workspace windows and terminal diagnostics.

## 2.9.0

### Minor Changes

- 32a16e6: Add persistent Omarchy-style workspace window tiling, drag-and-drop rearrangement, and geometric directional focus navigation.

## 2.8.0

### Minor Changes

- e705af6: Add File Browser and VS Code as embedded tiled windows alongside terminal and Git workspace panes.

## 2.7.4

### Patch Changes

- 42e2778: Load terminal runtime configuration before dashboard hydration and verify both browser and Coder WebSocket legs with acknowledged heartbeats so healthy sessions stay connected while half-open sessions recover automatically.

## 2.7.3

### Patch Changes

- 0a9a909: Use the Coder workspace name as the Kubernetes workspace hostname.

## 2.7.2

### Patch Changes

- 839c62c: Repair iPhone safe-area spacing, mobile terminal viewport locking, and narrow workspace header layout.

## 2.7.1

### Patch Changes

- d56032b: Allow the terminal WebSocket URL to be configured relative to the current browser host.

## 2.7.0

### Minor Changes

- 55d05f0: Launch the public CRT marketing experience, refresh authenticated workflows with responsive phosphor styling and keyboard navigation, add recovery and confirmation states, and ship an optional Cloudflare edge proxy with cross-device workflow coverage.

## 2.6.2

### Patch Changes

- e90281f: Initialize and fast-forward the Kubernetes workspace vault during startup, persist its repository for retries, and restrict repository destinations to the approved organizations.

## 2.6.1

### Patch Changes

- de10cc4: Register the Kubernetes Coder workspace template in the Hive templates UI and push API.

## 2.6.0

### Minor Changes

- 5fc3379: Add the Kubernetes Coder workspace template for Claude and Codex development environments.

## 2.5.14

### Patch Changes

- 0eeb00e: Fix multi-session workspace loading so terminal panes stay covered until every mounted session is connected and healthy.
- 831172c: Make terminal reconnects resilient to browser focus changes so healthy sessions stay connected and lost sessions refresh once.

## 2.5.13

### Patch Changes

- 5e09cee: Release the multi-session terminal focus fix so passive session reloads and recovery no longer move keyboard focus into hidden workspace panes.

## 2.5.12

### Patch Changes

- f3cd568: Stabilize the multi-session workspace close button so active boards can be closed reliably.

## 2.5.11

### Patch Changes

- a2d1527: Stabilize terminal websocket reconnects across browser lifecycle events.

## 2.5.10

### Patch Changes

- f728e8e: Restore terminal file paste when the browser Clipboard API does not expose copied files.

## 2.5.9

### Patch Changes

- f05d2f4: Prevent Ctrl+V image paste from dispatching through both the Clipboard API and native paste event paths.

## 2.5.8

### Patch Changes

- 88c7d90: Fix multi-session compose so commands send to the pane that opened compose.

## 2.5.7

### Patch Changes

- 42d00b0: Release the global dashboard keybinding and command palette fixes.

## 2.5.6

### Patch Changes

- dfda039: Add regression coverage for compose paste parity across regular terminal and multi-session workspace surfaces.

## 2.5.5

### Patch Changes

- 4ab327f: Make terminal clipboard paste reliable for text, images, and files by handling browser clipboard data before terminal apps can fall back to unavailable X11 clipboards, and stream pasted assets into Coder workspaces through the SSH stdio transport.

## 2.5.4

### Patch Changes

- 73e91a1: Scope xterm row selection to explicit selection mode so normal tmux mouse scrollback does not show browser selection artifacts.

## 2.5.3

### Patch Changes

- a320c32: Keep multi-session workspace panes warm while switching workspace boards so terminals stay mounted without reloading sessions.

## 2.5.2

### Patch Changes

- 18b7d67: Fix workspace terminal panes so single-session boards use the full available height.

## 2.5.1

### Patch Changes

- 8a2aba0: Fix terminal paste so Ctrl+V dispatches once and add the shared terminal context menu to multi-session workspace panes.

## 2.5.0

### Minor Changes

- ebfc79f: Unify terminal paste handling across desktop, mobile, tabbed, and multi-session terminals with compose staging for multiline text and workspace image paste uploads.

## 2.4.7

### Patch Changes

- 0598973: Fix the Coder template and hive-base Obsidian MCP seed configuration to use a published mcpvault package version so Codex, Claude Code, and pi can complete MCP startup.

## 2.4.6

### Patch Changes

- 508b542: Add in-place terminal connection recovery, Git pane proof refresh, sanitized proxy diagnostics, and workspace-board recovery status for terminal resilience.

## 2.4.5

### Patch Changes

- 67bfbf0: Tighten workspace board Git pane restoration metadata validation and avoid fallback key collisions for persisted Git panes.

## 2.4.4

### Patch Changes

- 8c0f1d6: Document terminal workspace updates and ignore generated agent evidence artifacts plus generated doc-contract tests.
- Updated dependencies [8c0f1d6]
  - @hive/auth@1.0.3
  - @hive/db@0.1.2

## 2.4.3

### Patch Changes

- 43f62fe: Add mobile terminal ergonomics, navigation favorites schema changes, terminal proxy resize coverage, and CI audit policy for the dev-only Vitest UI advisory.
- Updated dependencies [43f62fe]
  - @hive/db@0.1.1

## 2.4.2

### Patch Changes

- 179761f: Add Git clone discovery, home-root sidebar browsing, and session-bound persistent clone terminals with hardened proxy validation.
- Updated dependencies [179761f]
  - @hive/auth@1.0.2

## 2.4.1

### Patch Changes

- 630b81c: Migrate existing host-only session cookies to the configured domain scope and clear both cookie scopes on logout so the terminal WebSocket receives authentication on sibling subdomains.

## 2.4.0

### Minor Changes

- e0c0d38: Add the mobile-first agentic development experience.

## 2.3.2

### Patch Changes

- 5cdb610: Install Codex and maintained OpenGSD packages in Coder templates, wire Codex Playwright MCP/skills, and document workspace migration steps.

  Operator note: existing Coder workspaces created from the previous templates must be rebuilt or manually repaired so they stop resolving abandoned pre-OpenGSD packages and pick up the maintained `@opengsd` package shims, Codex CLI, Codex MCP config, and Codex skill wiring.

## 2.3.1

### Patch Changes

- c955598: Harden Helm rollout defaults and include the migrate image in deployment preflight coverage.

## 2.3.0

### Minor Changes

- 107a03d: Add terminal interaction layer: keybinding registry, clipboard copy/paste, session shortcuts, command palette, context menu, floating action button with virtual keys, and help overlay

## 2.2.0

### Minor Changes

- 5bcfc22: Add per-preview wildcard Certificate template for cookie-isolated preview environments. The chart now stamps a cert-manager Certificate covering both the preview host apex and `*.<host>` when `preview.enabled` is true.

## 2.1.11

### Patch Changes

- 3012717: Inject `NEXT_PUBLIC_TERMINAL_WS_URL` at runtime via `window.__HIVE_CONFIG__` so a single Docker image can be promoted across environments without rebuilding. Also document previously-undocumented env vars (login allowlist, Coder template IDs, pi provider defaults, tuning knobs, service bind config) in `.env.example`.

  Add `COOKIE_DOMAIN` env to the session cookie. When set (e.g. `.local.kethalia.com`), the cookie is sent to sibling subdomains, fixing the terminal-proxy `no_cookie → 401` rejection when the web UI and terminal-proxy live under different subdomains.

## 2.1.10

### Patch Changes

- a20ae21: Transpile `@hive/db` workspace package so Next/Turbopack resolves the generated Prisma client's `.js`-extension ESM imports during the production build.

## 2.1.9

### Patch Changes

- 033670c: Extract `@hive/db` workspace package owning the Prisma schema, migrations, and `PrismaClient` singleton. Web, auth, and migrate now import from `@hive/db` directly; the old `src/lib/db/index.ts` and `services/auth/src/db.ts` barrels are removed. New dedicated `hive-migrate` image runs `prisma migrate deploy` as a Helm hook.

## 2.1.8

### Patch Changes

- Updated dependencies [2323c3d]
  - @hive/auth@1.0.1

## 2.1.7

### Patch Changes

- 9674e1c: fix(auth): default AUTH_SERVICE_URL to in-cluster Service, treat empty as unset

  The hive-web and hive-terminal charts previously shipped `AUTH_SERVICE_URL: ""`
  in their default ConfigMap. Combined with the `??` operator in the client code,
  this resulted in a literal empty `baseUrl`, so `fetch(\`${baseUrl}/login\`)`threw`Failed to parse URL from /login` rather than falling back to the local
  default.

  - Charts now default `AUTH_SERVICE_URL: "http://hive-auth"` (the in-cluster
    Service rendered by `hive-auth` when `Release.Name = hive-auth`). Operators
    deploying under a different release (e.g. an umbrella where the Service
    renders as `<umbrella-release>-hive-auth`) MUST override this value.
  - Client code in `src/lib/auth/service-client.ts` and
    `services/terminal-proxy/src/auth.ts` switched from `??` to `||` so an
    explicitly empty `AUTH_SERVICE_URL` env var also falls through to the
    local dev default (`http://localhost:4400`).

## 2.1.6

### Patch Changes

- eaca1db: fix(charts): writable /tmp emptyDir under readOnlyRootFilesystem, opt-out toggle

  All three chart Deployments now mount a writable `/tmp` emptyDir
  (`name: hive-tmp`) so pods with `securityContext.readOnlyRootFilesystem: true`
  can satisfy tsx transpile cache writes and any `os.tmpdir()` callers without
  EROFS. The volume is enabled by default and can be disabled with
  `tmpVolume.enabled: false` for consumers that need to mount their own `/tmp`
  (e.g. a sized tmpfs or PVC). The volume name is chart-scoped (`hive-tmp`) to
  avoid colliding with user-supplied entries in `.Values.volumes` /
  `.Values.volumeMounts`.

## 2.1.5

### Patch Changes

- 51039a3: ci: trigger fresh release through the gated Release workflow

  The v1.0.3 release (commit `e581794`) ran Release in parallel with Build
  images on the merge `push`, so the retag step looked for
  `:sha-e581794` before Build had pushed it and errored with
  `Source image ... does not exist in registry`. Result: `hive-web` and
  `hive-auth` never got `:v1.0.3` / `:latest` tags published on GHCR
  (only `:sha-e581794`). `hive-terminal` was recovered manually via
  workflow_dispatch.

  PR #64 fixed the underlying race by switching Release to
  `workflow_run: ["Build images"] completed`. Patch-bump the stack so a
  release flows end-to-end through the gated workflow and produces the
  missing version tags.

## 2.1.4

### Patch Changes

- 9f7f91c: ci: pin reusable workflows to @v1 and consolidate changeset check via ci-changeset-check reusable

## 2.1.3

### Patch Changes

- a6a3aeb: Seed pi MCP config from `~/.claude/mcp.json` into `~/.mcp.json` (and the cloned project's `.gsd/mcp.json` in Hive workers) so pi picks up playwright/obsidian MCP servers from first boot. Pi only reads project-rooted MCP config, so without seeding it has no MCP tools when launched from `~` or any project without its own config. Also align playwright `DISPLAY` to `:1` (matching the KasmVNC display) across `claude-mcp.json`, both `tools-shell.sh` chrome aliases, and the ai-dev README.

## 2.1.2

### Patch Changes

- 672e7d6: Normalize HCL formatting in ai-dev template and refine VS Code color theme defaults so the template gets pushed to Coder.

## 2.1.1

### Patch Changes

- c1b4d7d: Fix PATH duplication on workspace rebuild by using binary path checks instead of command -v

## 2.1.0

### Minor Changes

- e1a2d80: Add auth service integration with session-based authentication, token lifecycle management, and auth middleware

## 2.0.1

### Patch Changes

- 085623a: Fix PR review findings: VAPID race condition, rate-limit memory leak, task auth scoping, PWA manifest path

## 2.0.0

### Major Changes

- ac09e67: Multi-user Coder authentication: replaced static CODER_URL/CODER_SESSION_TOKEN env vars with per-user, per-deployment credentials stored encrypted in Postgres. Added login/logout flow, session management, token auto-rotation, PWA support with push notifications for token expiry.

## 1.0.1

### Patch Changes

- 81bff95: Multi-target vault sync: copy skills and context files to ~/.claude/, ~/.agents/, ~/.pi/agent/ with independent per-directory manifest cleanup

## 1.0.0

### Major Changes

- 78c7ca4: Release pipeline: multi-stage Docker builds, CI validation, and GHCR publishing via changesets
