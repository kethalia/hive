import { readFileSync } from "node:fs";
import { z } from "zod";
import { boundedReleaseJson } from "../deploy/cloudflare/app/release-health";
import {
  epicMergePreparedSchema,
  epicMergeRpcRequestSchema,
  epicMergeTarget,
} from "../src/lib/delivery/epic-merge-contracts";
import { githubSourceDigest } from "../src/lib/delivery/github-evidence.server";
import { GitHubReleaseChangeRisk } from "../src/lib/delivery/release-change-risk.server";
import { isReleaseTestControlPath } from "../src/lib/delivery/release-control-paths";
import { releaseGitHubMerged } from "../src/lib/delivery/release-github-merged.server";
import {
  GitHubReleaseProvider,
  githubReleaseRequestSchema,
} from "../src/lib/delivery/release-github-provider.server";
import { GitHubReleaseRules } from "../src/lib/delivery/release-github-rules.server";
import { GitHubReleaseSourceDiscovery } from "../src/lib/delivery/release-source-discovery.server";
import { GitHubReleaseTestRunVerifier } from "../src/lib/delivery/release-tested-run.server";

// Only the fixed workspace helper invokes this entry. Credentials travel over
// its private local stdin pipe and are never returned in the signed RPC result.
export async function hostEpicMerge(raw: unknown, fetcher: typeof fetch = fetch) {
  const frame = z
    .object({
      request: epicMergeRpcRequestSchema,
      deadlineMs: z.number().int().positive().safe().optional(),
      token: z
        .string()
        .min(1)
        .max(4096)
        .refine((v) => !/[\r\n]/.test(v)),
    })
    .strict()
    .parse(raw);
  const { request: rpc, token } = frame,
    { config, source } = rpc,
    p = config.policy;
  if (source.repositoryId !== p.repositoryId || source.baseRef !== p.baseBranch)
    throw Error("epic_merge_scope");
  const remaining = (frame.deadlineMs ?? Date.now() + 25000) - Date.now();
  if (remaining <= 0) throw Error("epic_merge_expired");
  const signal = AbortSignal.timeout(Math.min(25000, remaining));
  const safeFetch: typeof fetch = async (input, init) => {
    signal.throwIfAborted();
    const url = new URL(String(input));
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash)
      throw Error("epic_merge_scope");
    const response = await fetcher(input, {
      ...init,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      redirect: "manual",
    });
    signal.throwIfAborted();
    if (response.redirected || (response.status >= 300 && response.status < 400))
      throw Error("epic_merge_redirect");
    return response;
  };
  const get = async (path: string) => {
    const response = await safeFetch(`https://api.github.com${path}`, {
      method: "GET",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw Error("epic_merge_scope");
    return boundedReleaseJson(response, 1048576, signal);
  };
  const identity = z
    .object({ id: z.number().int().positive().safe() })
    .passthrough()
    .parse(await get("/user"));
  if (String(identity.id) !== p.providerAccountId) throw Error("epic_merge_account");
  const metadata = () =>
    get(`/repositories/${p.repositoryId}`).then((raw) =>
      z
        .object({
          id: z.number().int().positive().safe(),
          full_name: z.literal(`${config.risk.owner}/${config.risk.name}`),
          default_branch: z.string(),
          archived: z.literal(false),
          permissions: z.object({ pull: z.literal(true), push: z.literal(true) }),
        })
        .parse(raw),
    );
  const repository = await metadata();
  const inTime = () => {
    if (Date.now() < p.validFrom || Date.now() >= p.expiresAt || signal.aborted)
      throw Error("epic_merge_expired");
  };
  inTime();
  if (
    String(repository.id) !== p.repositoryId ||
    p.baseBranch === repository.default_branch ||
    ["main", "master"].includes(p.baseBranch.toLowerCase())
  )
    throw Error("epic_merge_scope");
  const scope = { owner: config.risk.owner, name: config.risk.name };
  const rules = new GitHubReleaseRules(scope, token, safeFetch),
    risk = new GitHubReleaseChangeRisk(config.risk, token, safeFetch);
  const verifySource = (request: z.infer<typeof githubReleaseRequestSchema>) => {
    if (
      request.repositoryId !== source.repositoryId ||
      request.pullRequestId !== source.pullRequestId ||
      request.pullNumber !== source.pullNumber ||
      request.headSha !== source.headSha ||
      request.baseRef !== source.baseRef ||
      request.method !== p.method
    )
      throw Error("epic_merge_scope");
  };
  const preflight = async (
    request: z.infer<typeof githubReleaseRequestSchema>,
    complete = true,
  ) => {
    verifySource(request);
    const pull = z
      .object({
        head: z.object({
          ref: z.string(),
          sha: z.string(),
          repo: z.object({ id: z.number().int().positive().safe() }),
        }),
        base: z.object({
          ref: z.string(),
          repo: z.object({ id: z.number().int().positive().safe() }),
        }),
      })
      .passthrough()
      .parse(
        await get(`/repos/${config.risk.owner}/${config.risk.name}/pulls/${source.pullNumber}`),
      );
    if (
      pull?.head?.ref !== source.sourceBranch ||
      String(pull?.head?.repo?.id) !== p.repositoryId ||
      String(pull?.base?.repo?.id) !== p.repositoryId ||
      pull?.head?.sha !== source.headSha ||
      pull?.base?.ref !== p.baseBranch
    )
      throw Error("epic_merge_scope");
    const first = await rules.inspect(request, signal);
    if (first.digest !== request.rulesDigest) throw Error("epic_merge_rules");
    const tested = complete
      ? await rules.verifyTested(request, rpc.gates, signal)
      : await rules.inspectMerge(request, rpc.gates, signal);
    const classified = await risk.inspect(request, signal);
    if (
      classified.evidence.riskClass !== "application_only" ||
      classified.evidence.files.some(
        (f) =>
          isReleaseTestControlPath(f.filename) ||
          (!!f.previousFilename && isReleaseTestControlPath(f.previousFilename)),
      )
    )
      throw Error("epic_merge_risk");
    if ((await rules.inspect(request, signal)).digest !== first.digest || signal.aborted)
      throw Error("epic_merge_rules");
    if (githubSourceDigest(await metadata()) !== githubSourceDigest(repository))
      throw Error("epic_merge_scope");
    inTime();
    return { tested, classified };
  };
  let result: unknown;
  if (rpc.operation === "prepare") {
    const { sourceBranch: _branch, ...sourceScope } = source;
    const discovered = await new GitHubReleaseSourceDiscovery(
      { ...scope, repositoryId: p.repositoryId, baseRef: p.baseBranch, method: p.method },
      token,
      rules,
      safeFetch,
    ).read(sourceScope, signal);
    const observed = await preflight(discovered, rpc.test?.complete ?? true);
    if (rpc.test) {
      const input = rpc.test.request;
      if (
        input.repositoryId !== discovered.repositoryId ||
        input.pullNumber !== discovered.pullNumber ||
        input.headSha !== discovered.headSha ||
        input.baseSha !== discovered.baseSha ||
        input.mergeSha !== observed.tested.mergeSha ||
        input.treeSha !== observed.tested.treeSha
      )
        throw Error("epic_merge_test_scope");
      await new GitHubReleaseTestRunVerifier(config.tested.run, token, safeFetch).verify(
        input,
        rpc.test.complete,
        signal,
      );
    }
    result = epicMergePreparedSchema.parse({
      request: discovered,
      riskClass: "application_only",
      rulesDigest: discovered.rulesDigest,
      testedMergeSha: observed.tested.mergeSha,
      testedTreeSha: observed.tested.treeSha,
    });
  } else {
    if (rpc.identity.targetDigest !== epicMergeTarget(config)) throw Error("epic_merge_scope");
    verifySource(githubReleaseRequestSchema.parse(rpc.identity.request));
    const provider = new GitHubReleaseProvider(
      { ...scope, repositoryId: p.repositoryId, allowedBaseRef: p.baseBranch, mode: "preview" },
      token,
      async (request) => {
        try {
          await preflight(request);
          return true;
        } catch {
          return false;
        }
      },
      releaseGitHubMerged(scope, token, safeFetch),
      safeFetch,
    );
    result =
      rpc.operation === "dispatch"
        ? await provider.dispatch(rpc.identity, signal)
        : await provider.lookup(rpc.identity, rpc.reference, signal);
  }
  if (githubSourceDigest(await metadata()) !== githubSourceDigest(repository) || signal.aborted)
    throw Error("epic_merge_scope");
  return { schemaVersion: 1, requestId: rpc.requestId, operation: rpc.operation, result };
}
if (process.argv[1]?.endsWith("epic-merge-host.mjs")) {
  try {
    const bytes = readFileSync(0);
    if (bytes.length > 16384) throw Error("epic_merge_limit");
    process.stdout.write(JSON.stringify(await hostEpicMerge(JSON.parse(bytes.toString("utf8")))));
  } catch {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, error: "epic_merge_unavailable" }));
    process.exitCode = 1;
  }
}
