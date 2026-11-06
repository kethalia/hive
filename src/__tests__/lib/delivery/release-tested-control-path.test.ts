import { expect, it } from "vitest";
import { isReleaseTestControlPath } from "@/lib/delivery/release-tested-store.server";

it("allows ordinary test changes while protecting authority and fixed execution controls", () => {
  for (const path of [
    "src/__tests__/feature.test.ts",
    "src/lib/delivery/new-feature.test.ts",
    "tests/feature.spec.ts",
    "src/lib/delivery/feature.ts",
  ])
    expect(isReleaseTestControlPath(path)).toBe(false);
  for (const path of [
    ".github/workflows/controlled-tested-tree.yml",
    ".github/workflows/controlled-worker-upload.yml",
    ".github/workflows/ci.yml",
    ".github/actions/test/action.yml",
    "scripts/release/tested-attestor.mjs",
    "scripts/release/attestor.test.mjs",
    "services/migrate/src/delivery/runner.mjs",
    "src/lib/delivery/database-job-store.server.ts",
    "src/lib/delivery/release-tested-store.server.ts",
    "src/lib/delivery/release-control.test.ts",
    "src/lib/delivery/repository-policy.server.ts",
    "src/vitest.config.ts",
    "src/vitest.config.test.ts",
    "package.json",
    "pnpm-lock.yaml",
    "src/package.json",
  ])
    expect(isReleaseTestControlPath(path)).toBe(true);
});
