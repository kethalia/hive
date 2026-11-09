import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { githubReleaseRequestSchema } from "./release-github-provider.server";

const config = z
  .object({
    owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
    name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
  })
  .strict();
/** Read the exact PR after GitHub has returned our persisted asynchronous merge
 * UUID as merged. The UUID, not this desired-state read alone, attributes effect. */
export function releaseGitHubMerged(
  rawConfig: unknown,
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const fixed = config.parse(rawConfig);
  if (!token || token.length > 4096 || /[\r\n]/.test(token))
    throw Error("release_github_unavailable");
  return async (raw: unknown, sha: string, signal: AbortSignal) => {
    try {
      const request = githubReleaseRequestSchema.parse(raw);
      if (!/^[a-f0-9]{40}$/.test(sha)) return false;
      const response = await fetcher(
        `https://api.github.com/repos/${fixed.owner}/${fixed.name}/pulls/${request.pullNumber}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "error",
          signal,
        },
      );
      if (!response.ok) return false;
      const pull = z
        .object({
          id: z.number().int().positive().safe(),
          number: z.number().int().positive().safe(),
          state: z.literal("closed"),
          merged: z.literal(true),
          merge_commit_sha: z.string(),
          head: z.object({
            sha: z.string(),
            repo: z.object({ id: z.number().int().positive().safe() }),
          }),
          base: z.object({
            ref: z.string(),
            repo: z.object({ id: z.number().int().positive().safe() }),
          }),
        })
        .passthrough()
        .parse(await boundedReleaseJson(response, 1024 * 1024, signal));
      return (
        !signal.aborted &&
        String(pull.id) === request.pullRequestId &&
        pull.number === request.pullNumber &&
        String(pull.head.repo.id) === request.repositoryId &&
        String(pull.base.repo.id) === request.repositoryId &&
        pull.head.sha === request.headSha &&
        pull.base.ref === request.baseRef &&
        pull.merge_commit_sha === sha
      );
    } catch {
      return false;
    }
  };
}
