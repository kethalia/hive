import { afterEach, expect, it, vi } from "vitest";
import { readAppPreviewCatalog } from "@/lib/app-preview-catalog.server";

const sha = "a".repeat(40);
const hive = { full_name: "kethalia/hive" };
const pr = (number: number, ref: string, repo = hive) => ({
  number,
  title: `Preview ${number}`,
  head: { sha, ref, repo },
});
const goodCheck = {
  app: { id: 85455, slug: "cloudflare-workers-and-pages" },
  name: "Workers Builds: hive",
  conclusion: "success",
  head_sha: sha,
  details_url:
    "https://dash.cloudflare.com/225177f82b9234ede14e897fe15e0cb5/workers/services/view/hive/production/previews/codex-task/builds/8a962342-6bef-468a-9a42-c8e9c13533fd",
};

afterEach(() => vi.unstubAllGlobals());

it("lists a same-repository PR with a successful Cloudflare build for its head", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([pr(458, "codex/task"), pr(459, "codex/fork", { full_name: "fork/hive" })]),
    )
    .mockResolvedValueOnce(Response.json({ check_runs: [goodCheck] }));
  vi.stubGlobal("fetch", fetch);

  await expect(readAppPreviewCatalog()).resolves.toEqual([
    { number: 458, title: "Preview 458", branch: "codex/task", revision: sha, slug: "codex-task" },
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toContain(`/commits/${sha}/check-runs`);
});

it.each([
  { conclusion: "failure" },
  { app: { id: 99999, slug: goodCheck.app.slug } },
  { head_sha: "b".repeat(40) },
  {
    details_url: goodCheck.details_url.replace(
      "dash.cloudflare.com",
      "dash.cloudflare.com.example.org",
    ),
  },
  { details_url: goodCheck.details_url.replace("codex-task", "another-pr") },
])("skips a check with unverified preview metadata (%j)", async (change) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([pr(458, "codex/task")]))
      .mockResolvedValueOnce(Response.json({ check_runs: [{ ...goodCheck, ...change }] })),
  );
  await expect(readAppPreviewCatalog()).resolves.toEqual([]);
});

it("requires an unambiguous public preview hostname", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([pr(458, "codex/task"), pr(459, "codex-task")]))
      .mockResolvedValueOnce(Response.json({ check_runs: [goodCheck] }))
      .mockResolvedValueOnce(Response.json({ check_runs: [] })),
  );
  await expect(readAppPreviewCatalog()).resolves.toEqual([]);
});
