# S04 Research: External Tool Integration (Iframe Panels)

## Summary

S04 adds iframe-embedded Filebrowser and KasmVNC panels per workspace, with popup-out buttons and a Coder dashboard link-out. The URL construction logic already exists in `src/lib/workspaces/urls.ts` (delivered in S01), and the `/workspaces` list page already renders link-out buttons for running workspaces. The work is: (1) create a workspace detail page at `/workspaces/[id]` with tabbed iframe panels, (2) add iframe error detection with automatic popup fallback, and (3) wire navigation from the list page to the detail page.

## Recommendation

**Create a workspace detail route with tab-based iframe panels.** Use simple client-side tab state (Filebrowser | KasmVNC tabs) rather than installing a Tabs component — two buttons toggling which iframe renders is sufficient. The Coder Dashboard remains link-out only (external redirect) since Coder's dashboard sets `X-Frame-Options: DENY`. Each iframe panel gets a "Pop Out" button that opens the URL in a new tab. Iframe load errors trigger automatic fallback to popup behavior.

## Implementation Landscape

### Key Files

| File | Role |
|------|------|
| `src/lib/workspaces/urls.ts` | **Exists.** `buildWorkspaceUrls()` returns filebrowser, kasmvnc, dashboard URLs |
| `src/components/workspaces/WorkspacesClient.tsx` | **Exists.** List page with tool link buttons — needs link to detail page |
| `src/app/workspaces/[id]/page.tsx` | **New.** Workspace detail page (server component, fetches workspace by ID) |
| `src/components/workspaces/WorkspaceToolPanel.tsx` | **New.** Client component with iframe embed, tab switching, popup-out button, error fallback |
| `src/lib/actions/workspaces.ts` | **Exists.** May need a `getWorkspaceAction(id)` if not already present |
| `templates/ai-dev/main.tf` | **Reference only.** Confirms filebrowser and kasmvnc are subdomain-proxied coder_app modules |

### Build Order

1. **Add `getWorkspaceAction(id)`** — server action to fetch a single workspace by ID (if not already available)
2. **Create `WorkspaceToolPanel.tsx`** — client component containing:
   - Two-tab toggle: Filebrowser | KasmVNC (simple `useState` toggle, no library needed)
   - `<iframe>` rendering the selected tool URL with `sandbox="allow-same-origin allow-scripts allow-forms allow-popups"` 
   - "Pop Out" button per tab (opens URL in `window.open`)
   - Coder Dashboard link-out button (always opens in new tab)
   - Error detection via `onError` + a hidden fetch probe to detect X-Frame-Options blocking, with fallback to auto-popup
3. **Create `/workspaces/[id]/page.tsx`** — server component that loads workspace data and renders `WorkspaceToolPanel`
4. **Update `WorkspacesClient.tsx`** — make workspace name a `<Link>` to `/workspaces/{id}` for navigation to detail page

### Iframe Error Detection Strategy

Browsers do not fire a reliable `onError` event when an iframe is blocked by `X-Frame-Options` or CSP `frame-ancestors`. The practical approach:

1. Render the iframe normally
2. Use a parallel `fetch()` to the target URL (same-origin via Coder proxy) and check for `X-Frame-Options` response header — if present and restrictive, show a "Cannot embed — opening in new tab" message and auto-trigger `window.open`
3. As a belt-and-suspenders fallback, use a short `setTimeout` after iframe mount: if the iframe's `contentWindow` is inaccessible (cross-origin block), display the popup fallback UI
4. Note: Filebrowser and KasmVNC as Coder subdomain apps typically do NOT set X-Frame-Options, so blocking is unlikely in practice. The fallback is defensive.

### Verification Approach

- **Manual:** Load `/workspaces/[id]` for a running workspace, confirm Filebrowser and KasmVNC render in iframes, confirm tab switching works, confirm Pop Out opens new tab
- **Unit tests:** Test `WorkspaceToolPanel` renders correct iframe `src` based on active tab, test popup-out button calls `window.open`, test fallback UI renders when error state is set
- **Edge cases:** Stopped workspace shows disabled/empty state, missing CODER_URL env shows error message

## Common Pitfalls

- **Coder subdomain proxy cookies:** Iframes to Coder subdomain apps require the user to be authenticated with Coder. If the session cookie doesn't propagate (e.g., `SameSite=Strict`), the iframe will show a login page. This is a Coder platform behavior, not something Hive controls — document it as a known constraint.
- **Mixed content:** If Hive is served over HTTPS, the iframe URLs must also be HTTPS. The existing `buildWorkspaceUrls()` already constructs `https://` URLs, so this is handled.
- **iframe sandbox too restrictive:** KasmVNC requires `allow-scripts` and `allow-same-origin` at minimum. Filebrowser needs `allow-forms` for uploads. Start with a permissive sandbox or omit `sandbox` attribute entirely since these are trusted internal tools.
