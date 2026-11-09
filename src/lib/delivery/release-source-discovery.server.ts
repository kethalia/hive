import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import type { GitHubReleaseRules } from "./release-github-rules.server";

const config = z
  .object({
    owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
    name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    baseRef: z.string().min(1),
    method: z.enum(["merge", "squash", "rebase"]),
  })
  .strict();
const scope = z
  .object({
    repositoryId: z.string(),
    pullRequestId: z.string(),
    pullNumber: z.number().int().positive(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    baseRef: z.string(),
  })
  .strict();
export class GitHubReleaseSourceDiscovery {
  private readonly config: z.infer<typeof config>;
  constructor(
    raw: unknown,
    private readonly token: string,
    private readonly rules: GitHubReleaseRules,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = config.parse(raw);
    if (!token || token.length > 4096 || /[\r\n]/.test(token))
      throw Error("release_source_unavailable");
  }
  async read(raw: unknown, signal: AbortSignal) {
    const source = scope.parse(raw);
    if (source.repositoryId !== this.config.repositoryId || source.baseRef !== this.config.baseRef)
      throw Error("release_source_scope");
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.config.owner}/${this.config.name}/pulls/${source.pullNumber}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal,
      },
    );
    if (!response.ok) throw Error("release_source_unavailable");
    const p = z
      .object({
        id: z.number().int().positive().safe(),
        number: z.number().int().positive().safe(),
        state: z.literal("open"),
        draft: z.literal(false),
        head: z.object({
          sha: z.string(),
          repo: z.object({ id: z.number().int().positive().safe() }),
        }),
        base: z.object({
          sha: z.string().regex(/^[a-f0-9]{40}$/),
          ref: z.string(),
          repo: z.object({ id: z.number().int().positive().safe() }),
        }),
      })
      .passthrough()
      .parse(await boundedReleaseJson(response, 1024 * 1024, signal));
    if (
      String(p.id) !== source.pullRequestId ||
      p.number !== source.pullNumber ||
      String(p.head.repo.id) !== source.repositoryId ||
      String(p.base.repo.id) !== source.repositoryId ||
      p.head.sha !== source.headSha ||
      p.base.ref !== source.baseRef ||
      signal.aborted
    )
      throw Error("release_source_scope");
    const provisional = githubReleaseRequestSchema.parse({
      ...source,
      baseSha: p.base.sha,
      rulesDigest: "0".repeat(64),
      method: this.config.method,
    });
    const rules = await this.rules.inspect(provisional, signal);
    if (signal.aborted) throw Error("release_source_unavailable");
    return { ...provisional, rulesDigest: rules.digest };
  }
}
