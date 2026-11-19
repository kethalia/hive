import { createHash, createSign, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { repoId, repoName } from "./permissions";

const repository = z.object({ id: repoId, name: repoName, installationId: repoId });
const workspace = z
  .object({
    ownerId: z.string().uuid(),
    templateId: z.string().uuid(),
    keyHash: z.string().regex(/^[a-f0-9]{64}$/),
    repositories: z.array(repository).min(1).max(500),
  })
  .refine(
    (value) =>
      new Set(value.repositories.map((repo) => repo.id)).size === value.repositories.length &&
      new Set(value.repositories.map((repo) => repo.name.toLowerCase())).size ===
        value.repositories.length,
  );
export type InstallationRepository = z.infer<typeof repository>;

export function workspaceBinding(id: string) {
  const raw = process.env.HIVE_GITHUB_APP_WORKSPACES;
  if (!raw) return null;
  const bindings = z.record(z.string().uuid(), workspace).parse(JSON.parse(raw));
  return bindings[id] ?? null;
}

export function matchesWorkspaceKey(authorization: string | null, hash: string) {
  const value = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization ?? "");
  return (
    !!value &&
    timingSafeEqual(createHash("sha256").update(value[1]).digest(), Buffer.from(hash, "hex"))
  );
}

async function api(path: string, bearer: string, init?: RequestInit) {
  return fetch("https://api.github.com" + path, {
    ...init,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: "Bearer " + bearer,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "hive-workspace-permissions",
    },
  });
}

export async function revokeInstallationToken(token: string) {
  const response = await api("/installation/token", token, { method: "DELETE" });
  if (response.status !== 204 && response.status !== 401)
    throw new Error("GitHub revocation unavailable");
}

export async function issueRepositoryToken(repo: InstallationRepository, access: "read" | "write") {
  const appId = process.env.HIVE_GITHUB_APP_ID;
  const key = process.env.HIVE_GITHUB_APP_PRIVATE_KEY;
  if (!appId || !/^\d+$/.test(appId) || !key) throw new Error("GitHub App configuration missing");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({ iss: appId, iat: now - 60, exp: now + 300 });
  const jwt = payload + "." + createSign("RSA-SHA256").update(payload).sign(key, "base64url");
  const res = await api("/app/installations/" + repo.installationId + "/access_tokens", jwt, {
    method: "POST",
    body: JSON.stringify({ repository_ids: [repo.id], permissions: { contents: access } }),
  });
  if (!res.ok) throw new Error("GitHub rejected grant");
  const data = z
    .object({
      token: z.string().min(1),
      expires_at: z.string().datetime(),
      permissions: z.record(z.string(), z.string()),
      repositories: z.array(z.object({ id: repoId, full_name: repoName })),
    })
    .parse(await res.json());
  if (
    data.repositories.length !== 1 ||
    data.repositories[0].id !== repo.id ||
    data.repositories[0].full_name.toLowerCase() !== repo.name.toLowerCase() ||
    data.permissions.contents !== access ||
    Object.entries(data.permissions).some(
      ([k, v]) => k !== "contents" && !(k === "metadata" && v === "read"),
    )
  ) {
    await revokeInstallationToken(data.token);
    throw new Error("Unexpected GitHub grant");
  }
  return { token: data.token, expiresAt: new Date(data.expires_at) };
}

export async function installationRepository(repo: InstallationRepository, token: string) {
  const response = await api("/repositories/" + repo.id, token);
  if (!response.ok) throw new Error("GitHub repository unavailable");
  const value = z
    .object({
      id: repoId,
      node_id: z.string(),
      full_name: repoName,
      name: z.string(),
      owner: z.object({ login: z.string() }),
      default_branch: z.string(),
      private: z.boolean(),
      archived: z.boolean(),
      html_url: z.string(),
    })
    .parse(await response.json());
  if (value.id !== repo.id || value.full_name.toLowerCase() !== repo.name.toLowerCase())
    throw new Error("Repository changed");
  return value;
}
