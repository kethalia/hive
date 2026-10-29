// Transitional Node/SSH adapter. Replace with the authenticated host bridge before Cloudflare activation.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { authorizeWorkspaceAgent } from "@/lib/agents/workspace";
import {
  type ProjectErrorCode,
  projectErrorCodeSchema,
  projectPageSchema,
  projectRequestSchema,
} from "./contracts";

const HELPER_PATH = join(process.cwd(), "templates/ai-dev-k8s/scripts/github-projects.py");
const MAX_OUTPUT = 1024 * 1024;

export class ProjectDiscoveryError extends Error {
  constructor(public readonly code: ProjectErrorCode) {
    super(code);
  }
}

export async function discoverWorkspaceProjects(
  user: { id: string; coderUserId: string },
  input: unknown,
) {
  if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true")
    throw new ProjectDiscoveryError("discovery_disabled");
  const request = projectRequestSchema.parse(input);
  let authorized: Awaited<ReturnType<typeof authorizeWorkspaceAgent>>;
  try {
    authorized = await authorizeWorkspaceAgent(user, request.workspaceId);
  } catch (error) {
    throw new ProjectDiscoveryError(
      error instanceof Error && error.message.startsWith("Only the workspace owner")
        ? "workspace_forbidden"
        : "workspace_unavailable",
    );
  }
  const source = await readFile(HELPER_PATH, "utf8");
  const { client, target } = authorized;
  const reply = await new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      /* turbopackIgnore: true */ "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ProxyCommand=coder ssh --stdio --wait=no %h",
        target,
        `python3 -c '${source.replace(/'/g, "'\\''")}'`,
      ],
      {
        env: {
          ...process.env,
          CODER_URL: client.getBaseUrl(),
          CODER_SESSION_TOKEN: client.getSessionToken(),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    let size = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new ProjectDiscoveryError("discovery_unavailable"));
    };
    const timer = setTimeout(fail, 30_000);
    child.stderr.resume();
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) fail();
      else output += chunk.toString("utf8");
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const value = JSON.parse(output);
        const errorCode = projectErrorCodeSchema.safeParse(value?.error);
        if (code !== 0 && value?.schemaVersion === 1 && errorCode.success)
          reject(new ProjectDiscoveryError(errorCode.data));
        else if (code === 0) resolve(value);
        else reject(new ProjectDiscoveryError("discovery_unavailable"));
      } catch {
        reject(new ProjectDiscoveryError("discovery_unavailable"));
      }
    });
    child.stdin.end(
      JSON.stringify({ schemaVersion: 1, page: request.page, perPage: request.perPage }),
    );
  });
  const page = projectPageSchema.safeParse(reply);
  if (!page.success || page.data.page !== request.page || page.data.perPage !== request.perPage)
    throw new ProjectDiscoveryError("github_invalid_response");
  return page.data;
}
