---
estimated_steps: 44
estimated_files: 3
skills_used: []
---

# T02: Make terminal page full-viewport with keystroke exclusivity

---
estimated_steps: 4
estimated_files: 3
skills_used: []
---

# T02: Make terminal page full-viewport with keystroke exclusivity

**Slice:** S02 — Terminal Integration & Session Management
**Milestone:** M007

## Description

The terminal page at `/workspaces/[id]/terminal` currently uses `calc(100vh - 3.5rem - 3rem)` and `-m-6` for partial expansion. It needs to be truly full-viewport with exclusive keystroke capture (R063). The root layout applies `p-6 pt-14` to `<main>` — the terminal page must cancel this padding entirely.

Keystroke exclusivity (per D030): auto-focus xterm on mount, re-focus on container interaction. Add `stopPropagation` on the terminal wrapper to prevent keyboard events from reaching sidebar or other layout elements.

## Steps

1. In `src/app/workspaces/[id]/terminal/terminal-client.tsx`:
   - Change the terminal wrapper div from `-m-6` / `calc(100vh - 3.5rem)` to `-m-6 -mt-14` with `h-[100vh] w-[calc(100%+3rem)]` to fully cancel the layout's `p-6 pt-14` padding
   - Add `onKeyDown={(e) => e.stopPropagation()}` on the terminal wrapper div to prevent keystroke bubbling
   - Update the "Waiting for session" and Suspense fallback containers to use the same full-viewport sizing

2. In `src/components/workspaces/InteractiveTerminal.tsx`:
   - After `term.open(containerRef.current)` (around line 142), add `term.focus()` to auto-focus on mount
   - Add a click handler on the container div: `onClick={() => termRef.current?.focus()}` so clicking anywhere in the terminal area re-focuses xterm
   - This implements D030's strategy: auto-focus on mount, re-focus on click within terminal area

3. In `src/app/workspaces/[id]/terminal/page.tsx`:
   - Update the error state container to use full-viewport sizing consistent with the terminal view (`-m-6 -mt-14 h-[100vh]`)

4. Verify the terminal fills the viewport by checking the CSS changes compile and the component renders without errors.

## Must-Haves

- [ ] Terminal page fills full viewport (no layout padding visible)
- [ ] `term.focus()` called after mount
- [ ] Click on terminal container re-focuses xterm
- [ ] `stopPropagation` on terminal wrapper keydown events
- [ ] Error state also uses full-viewport sizing
- [ ] No TypeScript errors in modified files

## Verification

- `grep -q 'term.focus' src/components/workspaces/InteractiveTerminal.tsx` — focus call present
- `grep -q 'stopPropagation' src/app/workspaces/[id]/terminal/terminal-client.tsx` — keystroke isolation present
- `grep -q '\-mt-14' src/app/workspaces/[id]/terminal/terminal-client.tsx` — full-viewport margins present
- `pnpm tsc --noEmit 2>&1 | grep -v 'council-queues\|task-queue\|ioredis' | grep 'terminal' | grep -c 'error TS'` returns 0

## Inputs

- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — current terminal client with partial viewport expansion
- `src/components/workspaces/InteractiveTerminal.tsx` — xterm component needing focus management
- `src/app/workspaces/[id]/terminal/page.tsx` — server component with error state
- `src/app/layout.tsx` — root layout showing `p-6 pt-14` padding to cancel (read-only reference)

## Expected Output

- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — full-viewport sizing, stopPropagation on keydown
- `src/components/workspaces/InteractiveTerminal.tsx` — term.focus() on mount, click-to-refocus
- `src/app/workspaces/[id]/terminal/page.tsx` — error state with full-viewport sizing

## Inputs

- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/app/workspaces/[id]/terminal/page.tsx`
- `src/app/layout.tsx`

## Expected Output

- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/app/workspaces/[id]/terminal/page.tsx`

## Verification

grep -q 'term.focus' src/components/workspaces/InteractiveTerminal.tsx && grep -q 'stopPropagation' src/app/workspaces/[id]/terminal/terminal-client.tsx
