/**
 * Comment helper — thin gh CLI wrapper for posting PR comments.
 *
 * Comment failure is informational (D015): this function never throws.
 * Returns the comment URL on success, or null on failure.
 */

import { execFile as execFileCb } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { GH_CMD_TIMEOUT_MS } from "../constants.js";

const execFile = promisify(execFileCb);

/**
 * Post a comment to a GitHub PR via the `gh` CLI.
 *
 * Uses --body-file with a temp file instead of --body to avoid OS
 * argument-length limits on large council reports.
 *
 * @param prUrl - GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)
 * @param body  - Markdown comment body
 * @returns The URL of the posted comment, or null if posting failed.
 */
export async function postPRComment(prUrl: string, body: string): Promise<string | null> {
  const tmpFile = join(tmpdir(), `council-comment-${Date.now()}.md`);
  try {
    await writeFile(tmpFile, body, "utf-8");
    const { stdout } = await execFile(
      "gh",
      ["pr", "comment", prUrl, "--body-file", tmpFile],
      { timeout: GH_CMD_TIMEOUT_MS },
    );
    // gh outputs the comment URL on stdout; trim whitespace
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch (err) {
    // D015: comment failure is informational — log and return null
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[council-aggregator] Failed to post PR comment: ${msg}`);
    return null;
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}
