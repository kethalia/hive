import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import type { CoderClient } from "@/lib/coder/client";
import type { CoderWorkspace, WorkspaceResource } from "@/lib/coder/types";
import type { WorkspaceReadProfile } from "@/lib/workspaces/read-contracts";
import { createWorkspaceReadService } from "../../../../templates/ai-dev-k8s/scripts/hive-workspace-read.mjs";
export function readFixture(profile: WorkspaceReadProfile = "software") {
  const home = mkdtempSync(join(tmpdir(), "hive-read-client-")),
    root = join(home, "projects"),
    pkg = join(home, "package"),
    sockets = join(home, "sockets");
  for (const p of [root, pkg, sockets]) mkdirSync(p, { mode: 0o700 });
  const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex"),
    files: Record<string, string> = {};
  for (const name of ["hive-workspace-read.mjs", "hive-workspace-read.py"]) {
    copyFileSync(resolve("templates/ai-dev-k8s/scripts", name), join(pkg, name));
    files[name] = sha(readFileSync(join(pkg, name)));
  }
  const manifest = JSON.stringify({ schemaVersion: 1, files });
  writeFileSync(join(pkg, "manifest.json"), manifest, { mode: 0o600 });
  const issuer = generateKeyPairSync("ed25519"),
    keyId = "read-v1",
    hiveOrigin = "https://hive.invalid",
    templateId = randomUUID(),
    binding = {
      coderOrigin: "https://coder.invalid",
      hiveUserId: randomUUID(),
      ownerId: randomUUID(),
      workspaceId: randomUUID(),
      buildId: randomUUID(),
      agentId: randomUUID(),
      templateId,
      appOrigin: "https://hive-read--main--fixture--owner.apps.invalid",
      appId: randomUUID(),
    },
    { hiveUserId: _hive, ...fixed } = binding;
  const host = createWorkspaceReadService(
    {
      schemaVersion: 1,
      binding: fixed,
      profile,
      projectsRoot: root,
      home,
      hiveOrigin,
      issuerKeyId: keyId,
      issuerPublicKeyPem: issuer.publicKey.export({ type: "spki", format: "pem" }).toString(),
      packageDirectory: pkg,
      manifestSha256: sha(manifest),
      stateDirectory: join(home, ".local/state/hive/workspace-read", binding.buildId),
      port: 13342,
    },
    { socketDirectory: sockets, listenPort: 0 },
  );
  const workspace = {
    id: binding.workspaceId,
    name: "fixture",
    owner_id: binding.ownerId,
    owner_name: "owner",
    template_id: templateId,
    latest_build: { id: binding.buildId, status: "running" },
  } as CoderWorkspace;
  const app = {
    id: binding.appId,
    slug: "hive-read",
    sharing_level: "owner",
    subdomain: true,
    external: false,
    url: "http://127.0.0.1:13342",
  };
  const resources = [
    {
      id: randomUUID(),
      agents: [{ id: binding.agentId, name: "main", status: "connected", apps: [app] }],
    },
  ] as unknown as WorkspaceResource[];
  const coder = {
    getWorkspace: vi.fn<CoderClient["getWorkspace"]>(async () => structuredClone(workspace)),
    getWorkspaceResources: vi.fn<CoderClient["getWorkspaceResources"]>(async () =>
      structuredClone(resources),
    ),
    getApplicationsHost: vi.fn(async () => "*.apps.invalid"),
    getBaseUrl: () => binding.coderOrigin,
    getApplicationAuthRedirect: vi.fn(
      async (target: string) =>
        `${target}?coder_application_connect_api_key_35e783=fixture-app-only`,
    ),
  };
  const config = {
    privateKeyPem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId,
    hiveOrigin,
    profile,
    projectsRoot: root,
    home,
    manifestSha256: sha(manifest),
  };
  return {
    home,
    root,
    host,
    config,
    binding,
    coder,
    workspace,
    app,
    resources,
    principal: { hiveUserId: binding.hiveUserId, coderUserId: binding.ownerId },
    async close() {
      await host.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
