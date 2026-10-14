# tmux snapshot removal checks

Native tmux validation ran in the primary software workspace against an isolated
socket with the repository configuration. Two real attach-or-create clients
detach without replacing the server or pane process, and the same live output
remains available. The F12 menu remains bound; no save/restore options, plugin
bindings, or hooks are loaded. The same probe runs in every image's CI smoke test,
which also requires `/opt/tmux-plugins` to be absent.

Template regressions run the migration against a frozen fixture of the default
configuration from the retired
[`anomaly/tmux` 1.0.4 installer](https://github.com/coder/registry/blob/main/registry/anomaly/modules/tmux/scripts/run.sh).
They verify archival with private permissions, repeat startup, varied intervals,
preservation of custom/linked/non-text configurations, existing backups, and old
snapshot contents. These tests run in normal template/coverage CI.

Disposable Infrastructure workspace `daniel/hive-tmux-removal-check` validated
formatting and Terraform configuration for all five templates, with both Coder
and Kubernetes providers mocked for running and stopped plans. No live Terraform
plan or apply was run. The fixture and results are `tmux-app.tftest.hcl` and
`terraform-report.json`. `live-migration.json` records recognition and archival of
the fresh workspace's actual generated config without changing its contents.

Source changes and evidence were preserved in the primary checkout before
specialist cleanup. Tests do not restart any existing primary tmux server, read
old user pane contents, or delete snapshots. Rollout requires matching template
and image updates followed by planned workspace restarts; custom configuration
and historical snapshots still require owner review before Cloud closure.
