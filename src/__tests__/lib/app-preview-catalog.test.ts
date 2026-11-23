import { afterEach, expect, it, vi } from "vitest";
import { readAppPreviewCatalog } from "@/lib/app-preview-catalog.server";

const sha = "a".repeat(40);
const hive = { full_name: "kethalia/hive" };
const pr = (number: number, ref: string, repo = hive) => ({
  number,
  title: `Preview ${number}`,
  head: { sha, ref, repo },
});
const liveBuild = { branch: "codex/task", revision: sha };

afterEach(() => vi.unstubAllGlobals());

it("checks available previews directly using only one public GitHub request", async () => {
  const fetch = vi.fn().mockImplementation(async (url: string) => {
    if (url.startsWith("https://api.github.com/"))
      return Response.json([
        pr(458, "codex/task"),
        pr(459, "codex/another"),
        pr(460, "codex/fork", { full_name: "fork/hive" }),
      ]);
    if (url.startsWith("https://codex-task.")) return Response.json(liveBuild);
    return Response.json({ error: "No build" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);

  await expect(readAppPreviewCatalog()).resolves.toEqual([
    { number: 458, title: "Preview 458", branch: "codex/task", revision: sha, slug: "codex-task" },
  ]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://api.github.com/repos/kethalia/hive/pulls?state=open&base=main&sort=updated&per_page=30",
    "https://codex-task.hive-preview.kethalia.com/api/app-preview-build",
    "https://codex-another.hive-preview.kethalia.com/api/app-preview-build",
  ]);
  expect(fetch.mock.calls[1][1]).toMatchObject({ redirect: "manual" });
});

it("rejects GitHub redirects using Workers' supported redirect mode", async () => {
  const fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe("manual");
    return Response.redirect("https://api.github.com/other", 302);
  });
  vi.stubGlobal("fetch", fetch);

  await expect(readAppPreviewCatalog()).rejects.toThrow("GitHub preview catalog unavailable");
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  () => Response.json({ ...liveBuild, revision: "b".repeat(40) }),
  () => Response.json({ ...liveBuild, branch: "codex-task" }),
  () => Response.json({ ...liveBuild, revision: "invalid" }),
  () => Response.redirect("https://codex-task.hive-preview.kethalia.com/login", 307),
])("skips a preview that cannot verify the current branch and commit", async (previewResponse) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([pr(458, "codex/task")]))
      .mockResolvedValueOnce(previewResponse()),
  );
  await expect(readAppPreviewCatalog()).resolves.toEqual([]);
});

it("requires an unambiguous public preview hostname", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json([pr(458, "codex/task"), pr(459, "codex-task")]));
  vi.stubGlobal("fetch", fetch);
  await expect(readAppPreviewCatalog()).resolves.toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reports a temporary preview error instead of returning an empty catalog", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([pr(458, "codex/task")]))
      .mockResolvedValueOnce(new Response(null, { status: 503 })),
  );
  await expect(readAppPreviewCatalog()).rejects.toThrow(
    "Could not verify the deployed preview build",
  );
});
