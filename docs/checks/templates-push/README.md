# Template list and push progress validation

The template list now separates descriptions from the metadata columns, provides
one confirmed **Push all** action, and scrolls within the bounded dashboard.
Individual pushes and per-template success/failure reporting remain available.
The existing server worker limits execution to two template pushes at a time.

Validation uses the real React components, production Tailwind styles, and xterm
progress panels in a standalone fixture. Requests and SSE output are mocked;
no live template versions are created or activated.

The reused `creator-direction-upgrade` Browser Testing workspace ran installed
Chrome at desktop (1440×900), tablet touch (900×800), and phone touch (390×844)
viewports. The checks cover batch confirmation/cancellation, five independent
push requests including one rejected request, page-width containment, scrolling
past multiple panels, scrolling over output already at its bottom, and reaching
and closing the final panel. Touch checks also cover returning up the list
without pull-to-refresh stealing the gesture. This is Chrome touch emulation;
physical-device Safari acceptance is separate.

`report.json` records the assertions; the PNGs show the list and the bottom of
the progress stack at each viewport. The browser process is closed by the
runner. The reused workspace is retained because it serves another active task.

Build fixture assets in Software:

```sh
node e2e/templates-push-regressions.mjs --build-only /tmp/hive-templates-push/assets
```

Transfer the assets and runner to Browser Testing, where Chrome and either
`playwright-core` or `@playwright/test` are available, then run:

```sh
node e2e/templates-push-regressions.mjs /tmp/hive-templates-push/assets /tmp/hive-templates-push/evidence
```

Component regression coverage includes independent batch outcomes, stream
cleanup, empty-list disabling, individual pushes, and nested scroll-container
handling by pull-to-refresh:

```sh
pnpm exec vitest run src/__tests__/components/templates-list-mobile.test.tsx src/__tests__/components/template-detail.test.tsx src/__tests__/components/pull-to-refresh.test.tsx
```
