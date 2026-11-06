import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { githubSourceDigest } from "./github-evidence.server";
import { releaseTestChallengeRequestSchema } from "./release-tested-attestation.server";

const providerId = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const releaseTestRunConfigSchema = z
  .object({
    repositoryId: providerId,
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    workflowId: providerId,
    testJobName: z.string().min(1).max(100),
  })
  .strict();
/** Fixed read-only provider verifier. The challenge is issued only after the
 * reviewed test job succeeds; use requires the enclosing run also succeeds. */
export class GitHubReleaseTestRunVerifier {
  private readonly config: z.infer<typeof releaseTestRunConfigSchema>;
  constructor(
    raw: unknown,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = releaseTestRunConfigSchema.parse(raw);
    if (!token || token.length > 4096 || /[\r\n]/.test(token))
      throw Error("release_test_run_unavailable");
  }
  authority() {
    return structuredClone(this.config);
  }
  async verify(raw: unknown, complete: boolean, signal: AbortSignal) {
    const input = releaseTestChallengeRequestSchema.parse(raw);
    if (input.repositoryId !== this.config.repositoryId) throw Error("release_test_run_scope");
    const root = `https://api.github.com/repos/${this.config.owner}/${this.config.name}`;
    const get = async (path: string) => {
      const response = await this.fetcher(root + path, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal,
      });
      if (!response.ok || /rel\s*=\s*"?next"?/i.test(response.headers.get("link") ?? ""))
        throw Error("release_test_run_unavailable");
      return boundedReleaseJson(response, 1024 * 1024, signal);
    };
    const id = z.number().int().positive().safe();
    const run = z
      .object({
        id,
        run_attempt: id,
        workflow_id: id,
        event: z.literal("pull_request"),
        head_sha: z.literal(input.headSha),
        pull_requests: z
          .array(
            z
              .object({
                number: id,
                head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
                base: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
              })
              .passthrough(),
          )
          .max(20),
        status: z.string(),
        conclusion: z.string().nullable(),
        repository: z.object({ id }),
        head_repository: z.object({ id }),
      })
      .passthrough()
      .parse(await get(`/actions/runs/${input.runId}/attempts/${input.runAttempt}`));
    if (
      String(run.id) !== input.runId ||
      run.run_attempt !== input.runAttempt ||
      String(run.workflow_id) !== this.config.workflowId ||
      String(run.repository.id) !== input.repositoryId ||
      String(run.head_repository.id) !== input.repositoryId ||
      run.pull_requests.filter(
        (pr) =>
          pr.number === input.pullNumber &&
          pr.head.sha === input.headSha &&
          pr.base.sha === input.baseSha,
      ).length !== 1 ||
      run.pull_requests.filter((pr) => pr.number === input.pullNumber).length !== 1 ||
      (complete && (run.status !== "completed" || run.conclusion !== "success"))
    )
      throw Error("release_test_run_scope");
    const jobs = z
      .object({
        total_count: z.number().int().nonnegative().max(99),
        jobs: z
          .array(
            z
              .object({
                id,
                run_id: id,
                run_attempt: id,
                name: z.string(),
                status: z.string(),
                conclusion: z.string().nullable(),
              })
              .passthrough(),
          )
          .max(99),
      })
      .passthrough()
      .parse(
        await get(`/actions/runs/${input.runId}/attempts/${input.runAttempt}/jobs?per_page=100`),
      );
    const matches = jobs.jobs.filter((j) => j.name === this.config.testJobName);
    if (
      jobs.total_count !== jobs.jobs.length ||
      matches.length !== 1 ||
      matches[0].run_id !== run.id ||
      matches[0].run_attempt !== run.run_attempt ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success" ||
      signal.aborted
    )
      throw Error("release_test_run_scope");
    return {
      runId: input.runId,
      runAttempt: input.runAttempt,
      jobId: String(matches[0].id),
      authorityDigest: githubSourceDigest(this.config),
    };
  }
}
