# Launcher relevance validation

Validated on 2026-10-25 in the reused `creator-direction-upgrade` Browser Testing workspace.
The fixture uses production launcher and workspace components with mocked Coder/discovery data.
Desktop (1440 × 900) and mobile (390 × 844) checks passed with no browser errors; see `report.json`.

Build the shared fixture in the software workspace:

```sh
node scripts/build-window-management-fixture.mjs /tmp/hive-search-relevance/browser
```

Copy that directory and `e2e/search-relevance.browser.mjs` into Browser Testing, then run there:

```sh
HIVE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node search-relevance.browser.mjs /tmp/hive-search-relevance/browser
```

The script saves desktop/mobile screenshots and its report under the fixture's `evidence` directory.
Unit coverage also exercises metadata refreshes, delayed results, and retained keyboard selection
using real cmdk, alongside ranking and project filtering tests.
