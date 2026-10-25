# Workspace navigation

Browser validation reused `creator-direction-upgrade` (Browser Testing), which
also serves other work and must remain running. An isolated component fixture
used the real AppSidebar, TerminalSessionFrame, and WorkspacePaneActionSheet
with mocked Coder action results. The fixture server closed after validation;
no workspace lifecycle or authentication state was changed.

Chrome at 1440px and 390px verified Workspaces/Helpers grouping, absence of
repository and session navigation, font changes through More actions, no
horizontal overflow, and no browser exceptions. Screenshots and report.json are
preserved here. This fixture does not establish production Coder connectivity.

The corresponding component suite passed 144 tests; typecheck, Biome, and the
production Next.js build passed.
