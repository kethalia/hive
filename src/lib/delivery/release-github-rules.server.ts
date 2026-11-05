import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import type { GitHubEvidencePolicy } from "./github-contracts";
import { githubSourceDigest } from "./github-evidence.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";

const config = z
  .object({
    owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
    name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
  })
  .strict();
const id = z.number().int().positive().safe();
/** Conservative effective-rule producer. Requires classic branch protection
 * with strict checks, admin enforcement and PR review, plus no bypass actors in
 * any active ruleset applying to the branch. Missing permissions or unsupported
 * rule shapes hold. The caller still validates check producers and tested base. */
export class GitHubReleaseRules {
  private readonly config: z.infer<typeof config>;
  constructor(
    raw: unknown,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = config.parse(raw);
    if (!token || token.length > 4096 || /[\r\n]/.test(token))
      throw new Error("release_rules_unavailable");
  }
  /** Read current rules, enrolled selectors and exact test-merge parents. It
   * does not require the enclosing test workflow to have completed. */
  async inspectMerge(raw: unknown, policy: GitHubEvidencePolicy, signal: AbortSignal) {
    const request = githubReleaseRequestSchema.parse(raw);
    const root = `https://api.github.com/repos/${this.config.owner}/${this.config.name}`;
    const get = async (path: string) => {
      const response = await this.fetcher(`${root}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal,
      });
      if (!response.ok || /rel\s*=\s*"?next"?/i.test(response.headers.get("link") ?? ""))
        throw Error("release_tested_unavailable");
      return boundedReleaseJson(response, 1024 * 1024, signal);
    };
    const rules = await this.inspect(request, signal);
    const required = rules.evidence.protection.required_status_checks.checks;
    if (
      policy.checks.some(
        (c) => !required.some((r) => r.context === c.name && String(r.app_id) === c.appId),
      )
    )
      throw Error("release_tested_unavailable");
    const pull = z
      .object({
        id,
        number: id,
        state: z.literal("open"),
        merge_commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
        head: z.object({ sha: z.literal(request.headSha) }),
        base: z.object({ sha: z.literal(request.baseSha), ref: z.literal(request.baseRef) }),
      })
      .passthrough()
      .parse(await get(`/pulls/${request.pullNumber}`));
    if (String(pull.id) !== request.pullRequestId || pull.number !== request.pullNumber)
      throw Error("release_tested_unavailable");
    const commit = z
      .object({
        sha: z.literal(pull.merge_commit_sha),
        commit: z.object({ tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }),
        parents: z.array(z.object({ sha: z.string() })).length(2),
      })
      .passthrough()
      .parse(await get(`/commits/${pull.merge_commit_sha}`));
    if (commit.parents[0].sha !== request.baseSha || commit.parents[1].sha !== request.headSha)
      throw Error("release_tested_unavailable");
    if (signal.aborted || (await this.inspect(request, signal)).digest !== rules.digest)
      throw Error("release_tested_unavailable");
    return {
      mergeSha: pull.merge_commit_sha,
      treeSha: commit.commit.tree.sha,
      rulesDigest: rules.digest,
    };
  }
  /** Complete protected workflow and check verification is required only
   * after the trusted attestor job has finished. */
  async verifyTested(raw: unknown, policy: GitHubEvidencePolicy, signal: AbortSignal) {
    const request = githubReleaseRequestSchema.parse(raw);
    const tested = await this.inspectMerge(request, policy, signal);
    const root = `https://api.github.com/repos/${this.config.owner}/${this.config.name}`;
    const get = async (path: string) => {
      const response = await this.fetcher(`${root}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal,
      });
      if (!response.ok || /rel\s*=\s*"?next"?/i.test(response.headers.get("link") ?? ""))
        throw Error("release_tested_unavailable");
      return boundedReleaseJson(response, 1024 * 1024, signal);
    };
    const runs = z
      .object({
        total_count: z.number().int().nonnegative().max(99),
        workflow_runs: z
          .array(
            z
              .object({
                id,
                workflow_id: id,
                head_sha: z.literal(request.headSha),
                event: z.literal("pull_request"),
                status: z.literal("completed"),
                conclusion: z.literal("success"),
                run_attempt: id,
              })
              .passthrough(),
          )
          .max(99),
      })
      .passthrough()
      .parse(
        await get(
          `/actions/runs?head_sha=${request.headSha}&event=pull_request&status=success&per_page=100`,
        ),
      );
    if (runs.total_count !== runs.workflow_runs.length) throw Error("release_tested_unavailable");
    for (const check of policy.checks) {
      if (!check.events.includes("pull_request")) throw Error("release_tested_unavailable");
      const candidates = runs.workflow_runs.filter(
        (run) => String(run.workflow_id) === check.workflowId,
      );
      if (candidates.length !== 1) throw Error("release_tested_unavailable");
      const run = candidates[0];
      const jobs = z
        .object({
          total_count: z.number().int().nonnegative().max(99),
          jobs: z
            .array(
              z
                .object({
                  name: z.string(),
                  status: z.string(),
                  conclusion: z.string().nullable(),
                  run_id: id,
                  run_attempt: id,
                  check_run_url: z.string(),
                })
                .passthrough(),
            )
            .max(99),
        })
        .passthrough()
        .parse(await get(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`));
      if (jobs.total_count !== jobs.jobs.length) throw Error("release_tested_unavailable");
      const matches = jobs.jobs.filter((job) => job.name === check.name);
      if (
        matches.length !== 1 ||
        matches[0].status !== "completed" ||
        matches[0].conclusion !== "success" ||
        matches[0].run_id !== run.id ||
        matches[0].run_attempt !== run.run_attempt
      )
        throw Error("release_tested_unavailable");
      const checkUrl = new URL(matches[0].check_run_url);
      const prefix = `/repos/${this.config.owner}/${this.config.name}/check-runs/`;
      const checkId = checkUrl.pathname.startsWith(prefix)
        ? checkUrl.pathname.slice(prefix.length)
        : "";
      const match =
        checkUrl.origin === "https://api.github.com" &&
        !checkUrl.search &&
        !checkUrl.hash &&
        /^[1-9][0-9]*$/.test(checkId)
          ? checkId
          : null;
      if (!match) throw Error("release_tested_unavailable");
      const result = z
        .object({
          id,
          head_sha: z.literal(request.headSha),
          name: z.literal(check.name),
          status: z.literal("completed"),
          conclusion: z.literal("success"),
          app: z.object({ id }),
        })
        .passthrough()
        .parse(await get(`/check-runs/${match}`));
      if (String(result.id) !== match || String(result.app.id) !== check.appId)
        throw Error("release_tested_unavailable");
    }
    if (signal.aborted || (await this.inspect(request, signal)).digest !== tested.rulesDigest)
      throw Error("release_tested_unavailable");
    return tested;
  }
  async inspect(raw: unknown, signal: AbortSignal) {
    const request = githubReleaseRequestSchema.parse(raw);
    const root = `https://api.github.com/repos/${this.config.owner}/${this.config.name}`;
    const get = async (path: string) => {
      const response = await this.fetcher(`${root}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal,
      });
      if (
        !response.ok ||
        (response.headers.get("link") &&
          /rel\s*=\s*"?next"?/i.test(response.headers.get("link") ?? ""))
      )
        throw new Error("release_rules_unavailable");
      return boundedReleaseJson(response, 1024 * 1024, signal);
    };
    const repository = z
      .object({ id })
      .passthrough()
      .parse(await get(""));
    if (String(repository.id) !== request.repositoryId) throw new Error("release_rules_scope");
    const branch = encodeURIComponent(request.baseRef);
    const readBase = async () =>
      z
        .object({ commit: z.object({ sha: z.string() }) })
        .passthrough()
        .parse(await get(`/branches/${branch}`)).commit.sha;
    if ((await readBase()) !== request.baseSha) throw new Error("release_rules_scope");
    const protection = z
      .object({
        required_status_checks: z
          .object({
            strict: z.literal(true),
            checks: z
              .array(
                z.object({
                  context: z.string().min(1),
                  app_id: z.number().int().positive().safe(),
                }),
              )
              .min(1)
              .max(100),
          })
          .passthrough(),
        enforce_admins: z.object({ enabled: z.literal(true) }).passthrough(),
        required_pull_request_reviews: z
          .object({
            required_approving_review_count: z.number().int().positive(),
            bypass_pull_request_allowances: z
              .object({
                users: z.array(z.unknown()).length(0),
                teams: z.array(z.unknown()).length(0),
                apps: z.array(z.unknown()).length(0),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(await get(`/branches/${branch}/protection`));
    const rules = z
      .array(
        z
          .object({
            type: z.string().min(1),
            ruleset_id: id,
            ruleset_source_type: z.enum(["Repository", "Organization", "Enterprise"]),
            ruleset_source: z.string().min(1),
          })
          .passthrough(),
      )
      .max(99)
      .parse(await get(`/rules/branches/${branch}?per_page=100&page=1`));
    const ids = [...new Set(rules.map((rule) => rule.ruleset_id))].sort((a, b) => a - b);
    if (ids.length > 8) throw new Error("release_rules_unavailable");
    const sets = [];
    for (const ruleset of ids) {
      const detail = z
        .object({
          id,
          enforcement: z.literal("active"),
          bypass_actors: z.array(z.unknown()).length(0),
        })
        .passthrough()
        .parse(await get(`/rulesets/${ruleset}?includes_parents=true`));
      if (detail.id !== ruleset) throw new Error("release_rules_scope");
      sets.push(detail);
    }
    for (const [index, ruleset] of ids.entries()) {
      const current = await get(`/rulesets/${ruleset}?includes_parents=true`);
      if (githubSourceDigest(current) !== githubSourceDigest(sets[index]))
        throw new Error("release_rules_scope");
    }
    const finalProtection = await get(`/branches/${branch}/protection`);
    const finalRules = await get(`/rules/branches/${branch}?per_page=100&page=1`);
    if (
      signal.aborted ||
      (await readBase()) !== request.baseSha ||
      githubSourceDigest(finalProtection) !== githubSourceDigest(protection) ||
      githubSourceDigest(finalRules) !== githubSourceDigest(rules)
    )
      throw new Error("release_rules_scope");
    const evidence = {
      schemaVersion: 1,
      repositoryId: request.repositoryId,
      baseRef: request.baseRef,
      protection,
      rules,
      sets,
    };
    return { evidence, digest: githubSourceDigest(evidence) };
  }
}
