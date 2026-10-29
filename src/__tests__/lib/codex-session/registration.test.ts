import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type HostRegistration,
  type RegistrationStore,
  registrationProofPayload,
  resolveVerifiedWorkspaceHost,
  WorkspaceRegistrationAuthority,
} from "@/lib/codex-session/registration.server";

function fixture() {
  const issuer = generateKeyPairSync("ed25519");
  const host = generateKeyPairSync("ed25519");
  let now = 1000;
  let generation = 0;
  const grants = new Map<
    string,
    { binding: unknown; generation: number; expiresAt: number; digest?: string; consumed: boolean }
  >();
  let registered: HostRegistration | undefined;
  const store: RegistrationStore = {
    async reserve(value) {
      const next = ++generation;
      grants.set(value.grantId, { ...value, generation: next, consumed: false });
      return next;
    },
    async seal(value) {
      const row = grants.get(value.grantId);
      if (!row || row.generation !== value.generation) throw new Error("missing");
      row.digest = value.grantDigest;
    },
    async consumeAndRegister(value) {
      const row = grants.get(value.grantId);
      if (
        !row ||
        row.consumed ||
        row.generation !== generation ||
        row.generation !== value.registration.generation ||
        row.expiresAt <= value.now ||
        row.expiresAt !== value.expiresAt ||
        row.digest !== value.grantDigest ||
        JSON.stringify(row.binding) !== JSON.stringify(value.registration.binding)
      )
        return false;
      row.consumed = true;
      registered = value.registration;
      return true;
    },
  };
  const workspace = {
    id: "workspace",
    name: "workspace",
    owner_name: "owner",
    owner_id: "owner",
    template_id: "software",
    latest_build: {
      id: "build",
      status: "running" as const,
      job: { status: "succeeded", error: "" },
    },
  };
  const app = {
    id: "app",
    url: "http://127.0.0.1:13341/",
    slug: "codex-session",
    sharing_level: "owner",
    subdomain: true,
    external: false,
  };
  const agent = { id: "agent", name: "main", status: "connected" as const, apps: [app] };
  const coder = {
    getBaseUrl: () => "https://coder.example.com",
    getWorkspace: async () => structuredClone(workspace),
    getWorkspaceResources: async () => [
      { id: "resource", name: "pod", type: "pod", agents: [structuredClone(agent)] },
    ],
    getApplicationsHost: async () => "*.coder.example.com",
  };
  const config = {
    privateKeyPem: issuer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    keyId: "registration-key",
    hiveOrigin: "https://hive.example.com",
    softwareTemplateIds: ["software"],
    appSlug: "codex-session",
    gatewayPort: 13341,
    cookieDomains: ["hive.example.com"],
  };
  const dependencies = {
    coderForPrincipal: async () => coder,
    authorizedProjects: async () => [{ projectId: "project", repositoryId: "123" }],
    store,
    now: () => now,
  };
  const authority = new WorkspaceRegistrationAuthority(config, dependencies);
  const principal = { hiveUserId: "hive-user", coderUserId: "owner" };
  const issue = () => authority.issue(principal, "workspace", "agent", ["project"]);
  const request = (grant: string) => {
    const value = {
      grant,
      serverInstanceId: "server",
      protocolVersion: "0.165.0" as const,
      threads: [{ projectId: "project", repositoryId: "123", threadId: "thread" }],
      hostPublicKeyPem: host.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    return {
      ...value,
      proof: sign(null, Buffer.from(registrationProofPayload(value)), host.privateKey).toString(
        "base64url",
      ),
    };
  };
  return {
    authority,
    issue,
    request,
    principal,
    workspace,
    agent,
    app,
    coder,
    config,
    dependencies,
    registered: () => registered,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}

describe("provisioner registration authority", () => {
  it("binds independently verified Coder metadata and atomically registers only once", async () => {
    const f = fixture();
    const issued = await f.issue();
    expect(issued.binding.appOrigin).toBe(
      "https://codex-session--main--workspace--owner.coder.example.com",
    );
    const results = await Promise.allSettled([
      f.authority.redeem(f.request(issued.grant)),
      f.authority.redeem(f.request(issued.grant)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.registered()?.binding.ownerId).toBe("owner");
    expect(f.registered()?.threads[0].threadId).toBe("thread");
  });
  it("rejects other owners, nonsoftware templates and nonprivate apps", async () => {
    const f = fixture();
    await expect(
      f.authority.issue({ ...f.principal, coderUserId: "stranger" }, "workspace", "agent", [
        "project",
      ]),
    ).rejects.toThrow();
    f.workspace.template_id = "browser";
    await expect(f.issue()).rejects.toThrow();
    f.workspace.template_id = "software";
    f.app.sharing_level = "public";
    await expect(f.issue()).rejects.toThrow();
    f.app.sharing_level = "owner";
    f.app.subdomain = false;
    await expect(f.issue()).rejects.toThrow();
  });
  it("rechecks Coder build and owner at redemption, denying stale provisioner grants", async () => {
    const f = fixture();
    const grant = (await f.issue()).grant;
    f.workspace.latest_build.id = "new-build";
    await expect(f.authority.redeem(f.request(grant))).rejects.toThrow("Coder authority changed");
    expect(f.registered()).toBeUndefined();
    f.workspace.latest_build.id = "build";
    f.workspace.owner_id = "changed-owner";
    await expect(f.authority.redeem(f.request(grant))).rejects.toThrow();
  });
  it("denies expired grants, altered proofs, algorithms and caller URLs/identities", async () => {
    const f = fixture();
    const grant = (await f.issue()).grant;
    const request = f.request(grant);
    await expect(
      f.authority.redeem({ ...request, appOrigin: "https://attacker.test" }),
    ).rejects.toThrow();
    await expect(f.authority.redeem({ ...request, ownerId: "owner" })).rejects.toThrow();
    await expect(f.authority.redeem({ ...request, serverInstanceId: "changed" })).rejects.toThrow();
    const parts = grant.split(".");
    parts[0] = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT", kid: "registration-key" }),
    ).toString("base64url");
    await expect(f.authority.redeem(f.request(parts.join(".")))).rejects.toThrow();
    f.advance(60);
    await expect(f.authority.redeem(request)).rejects.toThrow();
  });
  it("fences older grants after a new generation without overwriting the latest registration", async () => {
    const f = fixture();
    const first = await f.issue();
    const second = await f.issue();
    await f.authority.redeem(f.request(second.grant));
    await expect(f.authority.redeem(f.request(first.grant))).rejects.toThrow("superseded");
    expect(f.registered()?.generation).toBe(second.generation);
  });
  it("rejects unregistered projects/repositories and duplicated thread ownership", async () => {
    const f = fixture();
    const grant = (await f.issue()).grant;
    for (const threads of [
      [{ projectId: "other", repositoryId: "123", threadId: "thread" }],
      [{ projectId: "project", repositoryId: "999", threadId: "thread" }],
      [f.request(grant).threads[0], f.request(grant).threads[0]],
    ])
      await expect(f.authority.redeem({ ...f.request(grant), threads })).rejects.toThrow();
  });
  it("fails closed on missing persistence, Coder unavailability and cookie-domain overlap", async () => {
    const f = fixture();
    expect(
      () =>
        new WorkspaceRegistrationAuthority(f.config, {
          ...f.dependencies,
          store: undefined as unknown as RegistrationStore,
        }),
    ).toThrow();
    const unsafe = new WorkspaceRegistrationAuthority(
      { ...f.config, cookieDomains: ["example.com"] },
      f.dependencies,
    );
    await expect(unsafe.issue(f.principal, "workspace", "agent", ["project"])).rejects.toThrow();
    f.coder.getWorkspace = async () => {
      throw new Error("Coder unavailable");
    };
    await expect(f.issue()).rejects.toThrow("Coder unavailable");
    expect(f.registered()).toBeUndefined();
  });
});

describe("shared host metadata authority", () => {
  it("resolves a unique owner-only app before any project enrollment", async () => {
    const f = fixture();
    f.dependencies.authorizedProjects = async () => [];
    const result = await resolveVerifiedWorkspaceHost(
      f.config,
      f.dependencies.coderForPrincipal,
      f.principal,
      "workspace",
    );
    expect(result.binding.agentId).toBe("agent");
    expect("projects" in result.binding).toBe(false);
    await expect(f.issue()).rejects.toThrow();
  });
  it("rejects ambiguous matching connected agents", async () => {
    const f = fixture();
    f.coder.getWorkspaceResources = async () => [
      {
        id: "resource",
        name: "pod",
        type: "pod",
        agents: [f.agent, { ...f.agent, id: "other-agent" }],
      },
    ];
    await expect(
      resolveVerifiedWorkspaceHost(
        f.config,
        f.dependencies.coderForPrincipal,
        f.principal,
        "workspace",
      ),
    ).rejects.toThrow();
  });
});
