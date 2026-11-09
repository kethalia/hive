import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { githubSourceDigest } from "./github-evidence.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";

export const releaseRiskConfigSchema = z
  .object({
    owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
    name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    // Operator-owned, exact path prefixes with a trailing slash. This is a path
    // classification only; it does not prove semantic compatibility or safety.
    allowedPrefixes: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/$/))
      .min(1)
      .max(32),
    databasePrefixes: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/$/))
      .max(32)
      .optional(),
  })
  .strict();
const fileSchema = z
  .object({
    filename: z.string().min(1).max(512),
    status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed"]),
    previous_filename: z.string().min(1).max(512).optional(),
  })
  .passthrough();
const pullSchema = z
  .object({
    id: z.number().int().positive().safe(),
    number: z.number().int().positive().safe(),
    state: z.literal("open"),
    draft: z.literal(false),
    changed_files: z.number().int().positive().max(99),
    head: z.object({ sha: z.string(), repo: z.object({ id: z.number().int().positive().safe() }) }),
    base: z.object({
      sha: z.string(),
      ref: z.string(),
      repo: z.object({ id: z.number().int().positive().safe() }),
    }),
  })
  .passthrough();
const safePath = (p: string) =>
  !p.startsWith("/") &&
  !p.includes("\\") &&
  [...p].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
  p.split("/").every((part) => part && part !== "." && part !== "..");

/** Fetches both sides of a PR file listing and rejects uncertain pagination,
 * renames outside the operator's application paths, or any head/base drift.
 * This does not replace CI, review, schema compatibility, or behavioral risk
 * attestation; those require their own independent authorities. */
export class GitHubReleaseChangeRisk {
  private readonly config: z.infer<typeof releaseRiskConfigSchema>;
  constructor(
    rawConfig: unknown,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = releaseRiskConfigSchema.parse(rawConfig);
    if (!token || token.length > 4096 || /[\r\n]/.test(token))
      throw new Error("release_risk_unavailable");
  }
  configDigest() {
    return githubSourceDigest(this.config);
  }
  async inspect(rawRequest: unknown, signal: AbortSignal) {
    const request = githubReleaseRequestSchema.parse(rawRequest);
    const root = `https://api.github.com/repos/${this.config.owner}/${this.config.name}/pulls/${request.pullNumber}`;
    const read = async (url: string) => {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("release_risk_unavailable");
      const value = await boundedReleaseJson(response, 1024 * 1024, signal);
      return { value, link: response.headers.get("link") };
    };
    const assertPull = (value: unknown) => {
      const p = pullSchema.parse(value);
      if (
        String(p.id) !== request.pullRequestId ||
        p.number !== request.pullNumber ||
        String(p.head.repo.id) !== request.repositoryId ||
        String(p.base.repo.id) !== request.repositoryId ||
        p.head.sha !== request.headSha ||
        p.base.sha !== request.baseSha ||
        p.base.ref !== request.baseRef
      )
        throw new Error("release_risk_scope_changed");
      return p;
    };
    const before = assertPull((await read(root)).value);
    const listed = await read(`${root}/files?per_page=100&page=1`);
    if (listed.link && /rel\s*=\s*"?next"?/i.test(listed.link))
      throw new Error("release_risk_incomplete");
    const files = z.array(fileSchema).max(99).parse(listed.value);
    if (
      files.length !== before.changed_files ||
      new Set(files.map((f) => f.filename)).size !== files.length
    )
      throw new Error("release_risk_incomplete");
    const paths = files.flatMap((f) => {
      if ((f.status === "renamed" || f.status === "copied") !== Boolean(f.previous_filename))
        throw new Error("release_risk_incomplete");
      return [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])];
    });
    if (
      paths.some(
        (path) =>
          !safePath(path) ||
          ![...this.config.allowedPrefixes, ...(this.config.databasePrefixes ?? [])].some(
            (prefix) => path.startsWith(prefix),
          ),
      )
    )
      throw new Error("release_risk_out_of_scope");
    const after = assertPull((await read(root)).value);
    if (after.changed_files !== before.changed_files || signal.aborted)
      throw new Error("release_risk_scope_changed");
    const evidence = {
      schemaVersion: 1,
      repositoryId: request.repositoryId,
      pullRequestId: request.pullRequestId,
      headSha: request.headSha,
      baseSha: request.baseSha,
      files: files
        .map((f) => ({
          filename: f.filename,
          status: f.status,
          ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
        }))
        .sort((a, b) => a.filename.localeCompare(b.filename)),
      riskClass: paths.some((path) =>
        (this.config.databasePrefixes ?? []).some((prefix) => path.startsWith(prefix)),
      )
        ? ("database" as const)
        : ("application_only" as const),
    };
    return { evidence, digest: githubSourceDigest(evidence) };
  }
}
