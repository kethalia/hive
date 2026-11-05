import { describe, expect, it, vi } from "vitest";
import type { GitHubReleaseChangeRisk } from "@/lib/delivery/release-change-risk.server";
import { releaseGitHubPreflight } from "@/lib/delivery/release-github-preflight.server";
import type { GitHubReleaseRules } from "@/lib/delivery/release-github-rules.server";

const request = {
  repositoryId: "1",
  pullRequestId: "2",
  pullNumber: 3,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  baseRef: "preview",
  rulesDigest: "c".repeat(64),
  method: "squash",
};
describe("release GitHub preflight", () => {
  it("requires the enrolled rule digest around the scoped file inspection", async () => {
    const inspect = vi.fn().mockResolvedValue({ digest: request.rulesDigest }),
      files = vi.fn().mockResolvedValue({});
    const check = releaseGitHubPreflight(
      { inspect } as unknown as GitHubReleaseRules,
      { inspect: files } as unknown as GitHubReleaseChangeRisk,
    );
    expect(await check(request, new AbortController().signal)).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(files).toHaveBeenCalledTimes(1);
    inspect
      .mockResolvedValueOnce({ digest: request.rulesDigest })
      .mockResolvedValueOnce({ digest: "d".repeat(64) });
    expect(await check(request, new AbortController().signal)).toBe(false);
  });
});
