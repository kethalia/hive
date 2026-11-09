export function isReleaseTestControlPath(path: string) {
  return (
    path.startsWith(".github/workflows/") ||
    path.startsWith(".github/actions/") ||
    path.startsWith("scripts/release/") ||
    path.startsWith("services/migrate/src/delivery/") ||
    path.startsWith("src/lib/delivery/database-job-") ||
    path.startsWith("src/lib/delivery/release-") ||
    path.startsWith("src/lib/delivery/epic-") ||
    path.startsWith("src/lib/delivery/account-maintenance-") ||
    path === "src/lib/delivery/execution-authority.server.ts" ||
    path.startsWith("src/lib/codex-session/account-maintenance-") ||
    path.startsWith("src/lib/codex-session/guardian-") ||
    path === "src/lib/codex-session/registration-store.server.ts" ||
    path === "src/app/api/workspaces/[id]/account-maintenance/route.ts" ||
    path === "src/app/api/workspaces/[workspaceId]/account-maintenance/route.ts" ||
    path === "scripts/host-epic-merge.ts" ||
    path === "scripts/host-production-release.ts" ||
    path === "scripts/build-codex-host-bundle.mjs" ||
    path.startsWith("deploy/cloudflare/native/") ||
    path === "deploy/cloudflare/app/automatic-health.ts" ||
    path === "deploy/cloudflare/auth/worker.ts" ||
    path === "services/auth/src/auth/readiness.ts" ||
    path === "services/auth/src/auth/domain.ts" ||
    path === "services/auth/src/fetch-handler.ts" ||
    path === "deploy/cloudflare/app/composition.ts" ||
    path === "deploy/cloudflare/app/build.mjs" ||
    path === "deploy/cloudflare/app/build-integrity.mjs" ||
    path === "src/lib/provider-build.ts" ||
    path === "src/lib/app-version.ts" ||
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
