import { afterEach, expect, it, vi } from "vitest";
import { isAppPreviewDeployed } from "@/lib/app-preview-catalog";
import { readAppPreviewCandidates } from "@/lib/app-preview-catalog.server";

const sha = "a".repeat(40);
const hive = { full_name: "kethalia/hive" };
const pr = (number: number, ref: string, repo = hive) => ({
  number,
  title: `Preview ${number}`,
  head: { sha, ref, repo },
});
const preview = { slug: "codex-task", branch: "codex/task", revision: sha };

afterEach(() => vi.unstubAllGlobals());

it("discovers same-repo open PRs with one request and avoids Worker-to-preview fetches", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([pr(458, "codex/task"), pr(459, "codex/another", { full_name: "fork/hive" })]),
    );
  vi.stubGlobal("fetch", fetch);

  await expect(readAppPreviewCandidates()).resolves.toEqual([
    { ...preview, number: 458, title: "Preview 458" },
  ]);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.github.com/repos/kethalia/hive/pulls?state=open&base=main&sort=updated&per_page=30",
    expect.objectContaining({ redirect: "manual" }),
  );
});

it("rejects GitHub redirects using Workers' supported redirect mode", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.redirect("https://api.github.com/other", 302));
  vi.stubGlobal("fetch", fetch);

  await expect(readAppPreviewCandidates()).rejects.toThrow("GitHub preview catalog unavailable");
  expect(fetch).toHaveBeenCalledOnce();
});

it("requires an unambiguous public preview hostname", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json([pr(458, "codex/task"), pr(459, "codex-task")]));
  vi.stubGlobal("fetch", fetch);

  await expect(readAppPreviewCandidates()).resolves.toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("verifies the deployed branch and commit without sending session credentials", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(preview));
  vi.stubGlobal("fetch", fetch);

  await expect(isAppPreviewDeployed(preview)).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://codex-task.hive-preview.kethalia.com/api/app-preview-build",
    expect.objectContaining({ credentials: "omit", redirect: "error" }),
  );
});

it.each([
  () => Response.json({ ...preview, revision: "b".repeat(40) }),
  () => Response.json({ ...preview, branch: "codex-task" }),
  () => Response.json({ ...preview, revision: "invalid" }),
  () => Response.redirect("https://codex-task.hive-preview.kethalia.com/login", 307),
  () => new Response(null, { status: 400 }),
])("skips a preview that cannot verify the current branch and commit", async (previewResponse) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(previewResponse()));
  await expect(isAppPreviewDeployed(preview)).resolves.toBe(false);
});
