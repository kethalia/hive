# Literal repository search

Repository results must contain the trimmed, case-insensitive search text in their
name or relative path. Workspace names and scattered letters no longer qualify a
repository for display. Empty search still lists all repositories.

Validated the real canvas and command palette in Chromium at 1440px and 390px in
the reused Browser Testing workspace `creator-direction-upgrade`, with mocked
Coder responses containing seven repositories in each of two running workspaces.
`hive` and ` HIVE ` show only `hive` and `hive-cache-maintenance` from each workspace.
Unrelated `realm-of-chill`, `rng-request-listener`, `hyperlane-registry-reference`,
`hawkeye`, and `house-of-slabs` results are excluded. Path search, unmatched queries,
workspace-only queries, clearing search, and opening a matching repository pass.
No browser runtime errors occurred. See `report.json` and the screenshots.

All 75 focused workspace-command, command-palette, and keyboard-controller tests
pass, along with typecheck and Biome checks. The specialist workspace is retained
running because it serves another active task; evidence is preserved here.
