# Workspace table action layout

Chrome validation reused the healthy `creator-direction-upgrade` Browser Testing
workspace. The isolated fixture rendered the real AppSidebar, SidebarProvider,
SidebarInset, WorkspaceListPoller, and WorkspaceListContent with repository CSS
and fonts. Coder actions and Next navigation were mocked; no real workspace
actions were invoked.

At desktop widths 1100, 1280, 1440, 1920, and 2560px, opening the sidebar preserved
all row heights (57px for running workspaces and 56.5px for the final stopped row).
Every action group stayed on one line. When needed, the existing table scroll
container exposed the rightmost action without overflowing the page. At 1440px,
restoring the old flex wrapping reproduced running row heights of 153px and a
stopped row height of 104.5px. At 390px the three mobile cards remained visible,
the desktop table stayed hidden, and the page did not overflow horizontally.

The screenshots show 1440px with the sidebar closed and open. The open view is
scrolled to the action column. Measurements are summarized in `report.json`.
The 15 existing workspace-list component tests and targeted Biome check passed.

The browser and fixture server closed after validation. This reused workspace
remains running because it also serves another active task.
