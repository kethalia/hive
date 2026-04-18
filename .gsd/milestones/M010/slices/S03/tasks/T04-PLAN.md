---
estimated_steps: 37
estimated_files: 4
skills_used: []
---

# T04: Add in-app token expiry banner to dashboard layout with server action

## Description

Creates the TokenExpiryBanner component (R105) and wires it into the dashboard layout. Uses the token status service from T02 via a server action. Banner shows destructive Alert for expired/key_mismatch tokens and default Alert for near-expiry tokens. Server component approach — checks on each navigation per R105 ("on next visit").

## Steps

1. Create a server action in `src/lib/auth/actions.ts` (extend existing file):
   - Add `getTokenStatusAction` using `authActionClient`:
     ```typescript
     export const getTokenStatusAction = authActionClient
       .action(async ({ ctx }) => {
         const status = await getTokenStatus(ctx.user.id);
         return status;
       });
     ```
   - Import `getTokenStatus` from token-status.ts

2. Create `src/components/token-expiry-banner.tsx`:
   - This is a server component that receives the token status as a prop (fetched by the layout)
   - Uses shadcn `Alert`, `AlertTitle`, `AlertDescription` from `src/components/ui/alert.tsx`
   - For 'expired' status: destructive variant, title "Token Expired", description "Your Coder API token has expired. Please log out and log in again to continue."
   - For 'key_mismatch' status: destructive variant, title "Re-authentication Required", description "The encryption key has changed. Please log out and log in again."
   - For 'expiring' status: default variant, title "Token Expiring Soon", description showing hours remaining (passed as prop)
   - For 'valid' status: render nothing (return null)
   - Use `AlertCircle` icon from lucide-react for destructive, `Clock` for expiring

3. Modify `src/app/(dashboard)/layout.tsx`:
   - Import `TokenExpiryBanner` from components
   - Import `getTokenStatusAction` from auth actions
   - Make the layout an async server component
   - Call `getTokenStatusAction()` at the top
   - If the action returns data, render `<TokenExpiryBanner>` above `{children}` inside `<main>`
   - Wrap the banner call in a try/catch — if it fails (e.g., no session), don't render banner (fail silently)
   - The banner should be inside `<main>` but above `{children}`, with no padding changes

4. Write tests in `src/__tests__/components/token-expiry-banner.test.tsx`:
   - Renders nothing for 'valid' status
   - Renders destructive alert for 'expired' status with correct message
   - Renders destructive alert for 'key_mismatch' status with re-auth message
   - Renders default alert for 'expiring' status with hours remaining
   - Uses shadcn Alert component (verify import)

5. Run `pnpm vitest run src/__tests__/components/token-expiry-banner.test.tsx`

6. Run full slice verification: `pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts src/__tests__/auth/token-status.test.ts src/__tests__/queue/token-rotation.test.ts src/__tests__/queue/task-queue-preflight.test.ts src/__tests__/components/token-expiry-banner.test.tsx`

## Inputs

- ``src/lib/auth/token-status.ts` — getTokenStatus from T02`
- ``src/lib/auth/actions.ts` — existing server actions to extend with getTokenStatusAction`
- ``src/app/(dashboard)/layout.tsx` — existing dashboard layout to add banner`
- ``src/components/ui/alert.tsx` — existing shadcn Alert component`

## Expected Output

- ``src/lib/auth/actions.ts` — getTokenStatusAction server action added`
- ``src/components/token-expiry-banner.tsx` — TokenExpiryBanner component`
- ``src/app/(dashboard)/layout.tsx` — banner wired above children in main`
- ``src/__tests__/components/token-expiry-banner.test.tsx` — banner component tests`

## Verification

pnpm vitest run src/__tests__/components/token-expiry-banner.test.tsx && grep -q 'TokenExpiryBanner' src/app/(dashboard)/layout.tsx
