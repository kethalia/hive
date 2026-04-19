---
estimated_steps: 24
estimated_files: 6
skills_used: []
---

# T04: Build login page UI, restructure layout for auth, and add sidebar session indicator

## Description

Presentation layer: login page with Coder URL, email, password fields and error display; layout restructuring so the sidebar only renders for authenticated routes; sidebar session indicator showing user email and Coder URL with logout button.

## Steps

1. Create `src/app/login/page.tsx` — client component with form state. Three inputs: Coder URL (type=url, placeholder 'https://coder.example.com'), Email (type=email), Password (type=password). Submit button with loading state. Error display area using shadcn Alert component. Calls `loginAction` via `useAction` hook from next-safe-action. On success, calls `router.push('/')` to navigate to dashboard. On rate limit error, shows 'Too many login attempts' message.
2. Create `src/app/login/layout.tsx` — minimal layout without sidebar. Just centers the login form vertically and horizontally with a max-width container. Include the Hive logo/title above the form.
3. Create `src/app/(dashboard)/layout.tsx` — move the sidebar rendering from root layout into this dashboard layout. Import SidebarProvider, AppSidebar, SidebarInset, SidebarTrigger. This layout wraps all authenticated routes.
4. Move existing route directories into the dashboard group: `src/app/tasks/` → `src/app/(dashboard)/tasks/`, `src/app/templates/` → `src/app/(dashboard)/templates/`, `src/app/workspaces/` → `src/app/(dashboard)/workspaces/`. Move `src/app/page.tsx` → `src/app/(dashboard)/page.tsx`.
5. Update `src/app/layout.tsx` — remove SidebarProvider, AppSidebar, SidebarInset, SidebarTrigger imports and rendering. Keep only html, body, fonts, TooltipProvider, and `{children}`.
6. Update `src/components/app-sidebar.tsx` — remove the `coderUrl` prop (no longer from env var). Instead, fetch session info via `getSessionAction` on mount. Display user email and connected Coder URL in the sidebar footer. Add a logout button that calls `logoutAction` and redirects to `/login` via `router.push('/login')`. Replace `process.env.CODER_URL` usage with session-derived Coder URL.
7. Verify: start dev server, confirm unauthenticated visit redirects to `/login`, confirm login page renders with three fields, confirm after mock login the sidebar shows user info and logout button works.

## Must-Haves

- [ ] Login page with Coder URL, email, password inputs using shadcn Input component
- [ ] Login form shows loading state during submission
- [ ] Login errors displayed via shadcn Alert component (distinct messages for invalid URL, bad creds, rate limit)
- [ ] Dashboard routes wrapped in (dashboard) route group with sidebar
- [ ] Root layout no longer renders sidebar directly
- [ ] Sidebar footer shows connected user email and Coder URL from session
- [ ] Sidebar logout button calls logoutAction and redirects to /login
- [ ] Login page layout centers form without sidebar

## Verification

- `test -f src/app/login/page.tsx && test -f src/app/(dashboard)/layout.tsx` — key files exist
- `! grep -q 'AppSidebar' src/app/layout.tsx` — sidebar removed from root layout
- `grep -q 'AppSidebar' 'src/app/(dashboard)/layout.tsx'` — sidebar in dashboard layout
- `grep -q 'logoutAction' src/components/app-sidebar.tsx` — logout wired in sidebar

## Inputs

- ``src/lib/auth/actions.ts` — loginAction, logoutAction, getSessionAction from T03`
- ``src/app/layout.tsx` — existing root layout to simplify`
- ``src/components/app-sidebar.tsx` — existing sidebar to extend with session indicator and logout`

## Expected Output

- ``src/app/login/page.tsx` — login page with form`
- ``src/app/login/layout.tsx` — minimal login layout`
- ``src/app/(dashboard)/layout.tsx` — dashboard layout with sidebar`
- ``src/app/(dashboard)/page.tsx` — moved dashboard home page`
- ``src/app/layout.tsx` — simplified root layout without sidebar`
- ``src/components/app-sidebar.tsx` — updated with session indicator and logout`

## Verification

test -f src/app/login/page.tsx && test -f 'src/app/(dashboard)/layout.tsx' && ! grep -q 'AppSidebar' src/app/layout.tsx && grep -q 'logoutAction' src/components/app-sidebar.tsx
