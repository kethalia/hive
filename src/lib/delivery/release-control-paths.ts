export function isReleaseTestControlPath(path: string) {
  return (
    path.startsWith(".github/workflows/") ||
    path.startsWith(".github/actions/") ||
    path.startsWith("scripts/release/") ||
    path.startsWith("services/migrate/src/delivery/") ||
    path.startsWith("src/lib/delivery/database-job-") ||
    path.startsWith("src/lib/delivery/release-") ||
    path.startsWith("src/lib/delivery/epic-") ||
    path === "scripts/host-epic-merge.ts" ||
    path === "src/lib/projects/host.server.ts" ||
    path === "src/lib/codex-session/bootstrap-delivery.server.ts" ||
    path === "templates/ai-dev-k8s/scripts/github-projects.py" ||
    path === "templates/ai-dev-k8s/scripts/codex-project-controller.mjs" ||
    path === "templates/ai-dev-k8s/scripts/codex-project-discovery.mjs" ||
    path === "templates/ai-dev-k8s/scripts/codex-workspace-host.mjs" ||
    path.startsWith("src/lib/delivery/repository-policy") ||
    path.startsWith("src/lib/delivery/acceptance-") ||
    path.startsWith("src/lib/delivery/manager") ||
    path.startsWith("src/lib/delivery/source-resolver") ||
    path === "src/lib/delivery/state.ts" ||
    path === "src/lib/delivery/contracts.ts" ||
    path === "src/lib/delivery/completion-transaction.server.ts" ||
    path.startsWith("src/app/api/internal/release-") ||
    path === "src/proxy.ts" ||
    /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.[^/]+|[^/]+\.config\.[^/]+|tsconfig[^/]*\.json)$/.test(
      path,
    )
  );
}
