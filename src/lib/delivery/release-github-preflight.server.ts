import type { GitHubReleaseChangeRisk } from "./release-change-risk.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import type { GitHubReleaseRules } from "./release-github-rules.server";

/** Fresh, fixed read-only preflight immediately before a merge request. Source,
 * CI/review attestations, lifecycle authorization and compatibility are still
 * independently checked by the caller. Reads cannot provide an atomic GitHub
 * expected-base condition; strict provider checks and a later merge receipt
 * are required. */
export function releaseGitHubPreflight(rules: GitHubReleaseRules, risk: GitHubReleaseChangeRisk) {
  return async (raw: unknown, signal: AbortSignal) => {
    try {
      const request = githubReleaseRequestSchema.parse(raw);
      const first = await rules.inspect(request, signal);
      if (first.digest !== request.rulesDigest || signal.aborted) return false;
      await risk.inspect(request, signal);
      const last = await rules.inspect(request, signal);
      return !signal.aborted && last.digest === first.digest;
    } catch {
      return false;
    }
  };
}
