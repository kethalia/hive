import { Queue, Worker, type Job } from "bullmq";
import { execFile, spawn } from "child_process";
import { createWriteStream } from "fs";
import { readdir } from "fs/promises";
import { promisify } from "util";
import { join } from "path";
import { getRedisConnection } from "@/lib/queue/connection";
import { getCoderClientForUser } from "@/lib/coder/user-client";

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────────

export const TEMPLATE_PUSH_QUEUE = "template-push";

/** Job data for a template push job. */
export interface TemplatePushJobData {
  templateName: string;
  jobId: string;
  userId: string;
}

// ── Log path helper ───────────────────────────────────────────────

/** Returns the path of the tee log file for a push job. */
export function pushLogPath(jobId: string): string {
  return `/tmp/template-push-${jobId}.log`;
}

// ── Queue ─────────────────────────────────────────────────────────

let pushQueue: Queue<TemplatePushJobData> | null = null;

/** Returns the shared template-push Queue singleton. */
export function getTemplatePushQueue(): Queue<TemplatePushJobData> {
  if (!pushQueue) {
    // @ts-ignore — pre-existing ioredis dual-install type mismatch (see KNOWLEDGE.md)
    const q = new Queue<TemplatePushJobData>(TEMPLATE_PUSH_QUEUE, {
      // @ts-ignore
      connection: getRedisConnection(),
    });
    pushQueue = q as Queue<TemplatePushJobData>;
  }
  return pushQueue!;
}

// ── Coder binary resolution ───────────────────────────────────────

/**
 * Locate the coder binary.
 * Checks subdirectories of /tmp matching "coder.*" for a "coder" binary
 * (common Coder workspace path), then falls back to PATH via `which`.
 */
async function findCoderBinary(): Promise<string> {
  // Scan /tmp for directories matching coder.* that contain a coder binary
  try {
    const tmpEntries = await readdir("/tmp", { withFileTypes: true });
    for (const entry of tmpEntries) {
      if (entry.isDirectory() && entry.name.startsWith("coder.")) {
        const candidate = join("/tmp", entry.name, "coder");
        try {
          await execFileAsync(candidate, ["version"], { timeout: 3000 });
          return candidate;
        } catch {
          // This candidate doesn't work — try next
        }
      }
    }
  } catch {
    // /tmp not readable — fall through
  }

  // Try PATH resolution
  try {
    const { stdout } = await execFileAsync("which", ["coder"]);
    const binary = stdout.trim();
    if (binary) return binary;
  } catch {
    // not on PATH
  }

  throw new Error("[template-push] coder binary not found — checked /tmp/coder.*/coder and PATH");
}

// ── Worker ────────────────────────────────────────────────────────

/**
 * Creates a BullMQ worker that processes template push jobs.
 *
 * For each job:
 *   1. Finds the coder binary
 *   2. Spawns `coder templates push <name> --directory templates/<name> --yes`
 *   3. Tees stdout+stderr to /tmp/template-push-<jobId>.log
 *   4. Appends [exit:0] or [exit:1] sentinel on process close
 *   5. Resolves/rejects based on exit code
 */
export function createTemplatePushWorker(): Worker<TemplatePushJobData> {
  // @ts-ignore — pre-existing ioredis dual-install type mismatch
  return new Worker<TemplatePushJobData>(
    TEMPLATE_PUSH_QUEUE,
    async (job: Job<TemplatePushJobData>) => {
      const { templateName, jobId, userId } = job.data;
      const logPath = pushLogPath(jobId);

      console.log(`[template-push] Starting push for "${templateName}" (job ${jobId})`);

      const client = await getCoderClientForUser(userId);
      const coderBin = await findCoderBinary();
      const logStream = createWriteStream(logPath, { flags: "a" });

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          coderBin,
          [
            "templates",
            "push",
            templateName,
            "--directory",
            `templates/${templateName}`,
            "--yes",
          ],
          {
            env: {
              ...process.env,
              CODER_URL: client.getBaseUrl(),
              CODER_SESSION_TOKEN: client.getSessionToken(),
            },
          }
        );

        child.stdout.pipe(logStream, { end: false });
        child.stderr.pipe(logStream, { end: false });

        child.on("close", (code) => {
          const sentinel = `\n[exit:${code === 0 ? 0 : 1}]\n`;
          logStream.write(sentinel, () => {
            logStream.end();
          });

          if (code === 0) {
            console.log(`[template-push] Push succeeded for "${templateName}" (job ${jobId})`);
            resolve();
          } else {
            console.error(`[template-push] Push failed for "${templateName}" (job ${jobId}) — exit code ${code}`);
            reject(new Error(`coder templates push exited with code ${code}`));
          }
        });

        child.on("error", (err) => {
          const msg = `\n[error: ${err.message}]\n[exit:1]\n`;
          logStream.write(msg, () => {
            logStream.end();
          });
          reject(err);
        });
      });
    },
    {
      // @ts-ignore — pre-existing ioredis dual-install type mismatch
      connection: getRedisConnection(),
      concurrency: 2,
    }
  );
}
