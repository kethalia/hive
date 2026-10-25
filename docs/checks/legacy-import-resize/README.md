# Legacy file imports and canvas resizing

Validated on 2026-10-25 in the reused `creator-direction-upgrade` Browser Testing workspace. It remains running for another active task. The fixture bundles the real canvas, import/storage logic, mobile shell, layout code, panes, and styles; Coder actions and the terminal runtime use fixture data.

The 24 focused state/layout tests cover both legacy storage formats, distinct absolute file targets, exact duplicate removal, session identity, invalid descriptors, unique window IDs, preservation of original storage, and existing layout behavior. TypeScript and Biome also pass.

Chrome verified:

- A desktop → mobile → tall desktop → wide desktop sequence observes the current canvas exactly once, disconnecting observers attached to replaced elements.
- Adding a window after the mobile-to-desktop transition chooses an `x` split for the tall canvas; after resizing the replacement canvas, it chooses a `y` split for the wide canvas.
- Legacy Files panes for `README.md` and `index.ts` import as distinct embedded windows and request fresh authorization for their saved absolute paths.
- An exact duplicate is removed; original legacy storage remains unchanged. The imported state persists after selecting a pane without saving authorization URLs.
- No browser page errors.

`report.json` contains measured dimensions, observer counts, split axes, and imported targets. Screenshots show the resized desktop canvas and imported file windows. No live Coder resource was changed.
