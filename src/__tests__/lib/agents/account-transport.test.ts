import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), coder: vi.fn(), session: vi.fn() }));
vi.mock("@hive/db", () => ({
  getDb: () =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "user") return { findUnique: mocks.user };
          throw Error(`Unexpected database delegate ${String(property)}`);
        },
      },
    ),
}));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: mocks.coder }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));

import { codexAccountRoute } from "@/lib/agents/codex-account-route.server";
import { agentCanonical, agentProofPayload } from "@/lib/agents/portable-contracts";

const issuer = generateKeyPairSync("ed25519");
const host = generateKeyPairSync("ed25519");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hiveOrigin = "https://hive.example";
const coderOrigin = "https://coder.example";
const ownerId = randomUUID();
const hiveUserId = randomUUID();
const workspaceId = randomUUID();
const buildId = randomUUID();
const templateId = randomUUID();
const agentId = randomUUID();
const appId = randomUUID();
const lifetimeId = randomUUID();
const appOrigin = "https://hive-agent--main--work--owner.apps.example";
const binding = {
  coderOrigin,
  ownerId,
  workspaceId,
  buildId,
  templateId,
  agentId,
  appId,
  appOrigin,
};
const cookieName = `coder_subdomain_app_session_token_${sha("*.apps.example").slice(0, 32)}`;
const installedManifest = "a".repeat(64);
const installedHelper = "b".repeat(64);
let currentBuild: string;
let currentOwner: string;
let currentTemplate: string;
let replaceAfterAction: boolean;
const operations: string[] = [];
const getWorkspace = vi.fn(async () => ({
  id: workspaceId,
  name: "work",
  owner_name: "owner",
  owner_id: currentOwner,
  template_id: currentTemplate,
  latest_build: { id: currentBuild, status: "running" },
}));
const getResources = vi.fn(async () => [
  {
    agents: [
      {
        id: agentId,
        name: "main",
        status: "connected",
        apps: [
          {
            id: appId,
            slug: "hive-agent",
            sharing_level: "owner",
            subdomain: true,
            external: false,
            url: "http://127.0.0.1:13344/",
          },
        ],
      },
    ],
  },
]);
const coder = {
  getWorkspace,
  getWorkspaceResources: getResources,
  getApplicationsHost: vi.fn(async () => "*.apps.example"),
  getBaseUrl: () => coderOrigin,
  getApplicationAuthRedirect: vi.fn(
    async (target: string) => `${target}?coder_application_connect_api_key_35e783=encrypted`,
  ),
};
const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
  if (init?.method === "GET")
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/agent/operation",
        "Set-Cookie": `${cookieName}=private_cookie; Path=/; Secure; HttpOnly`,
      },
    });
  expect(init?.headers).toEqual({
    "Content-Type": "application/json",
    Cookie: `${cookieName}=private_cookie`,
  });
  const packet = JSON.parse(String(init?.body)).ticket as string;
  const [header, payload, signature] = packet.split(".");
  expect(
    verify(
      null,
      Buffer.from(`${header}.${payload}`),
      issuer.publicKey,
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  expect(claims.binding).toEqual({ ...binding, hiveUserId });
  operations.push(claims.request.operation);
  const identity = claims.request.operation === "identity";
  const data = identity
    ? {
        publicKeyPem: host.publicKey.export({ type: "spki", format: "pem" }).toString(),
        manifestSha256: installedManifest,
        environment: {},
        configDigest: sha(
          agentCanonical({
            schemaVersion: 1,
            issuer: hiveOrigin,
            issuerKeyId: "test",
            issuerPublicKeySha256: sha(issuer.publicKey.export({ type: "spki", format: "der" })),
            binding,
            profile: "software",
            home: "/home/coder",
            manifestSha256: installedManifest,
            helperSha256: installedHelper,
            environment: {},
          }),
        ),
      }
    : { scope: "managed-native", lifetimeId, generation: 0, state: "signed-out", pending: null };
  if (!identity && replaceAfterAction) currentBuild = randomUUID();
  const response = {
    schemaVersion: 1,
    requestId: claims.jti,
    lifetimeId,
    operation: claims.request.operation,
    result: { ok: true, data },
  };
  return Response.json({
    ...response,
    proof: sign(null, Buffer.from(agentProofPayload(response)), host.privateKey).toString(
      "base64url",
    ),
  });
});
function request(selectedBuild = buildId) {
  return new Request(`${hiveOrigin}/api/workspaces/${workspaceId}/codex-account`, {
    method: "POST",
    headers: { Origin: hiveOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ buildId: selectedBuild, request: { action: "status" } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  operations.length = 0;
  currentBuild = buildId;
  currentOwner = ownerId;
  currentTemplate = templateId;
  replaceAfterAction = false;
  mocks.user.mockResolvedValue({ coderUserId: ownerId });
  mocks.coder.mockResolvedValue(coder);
  mocks.session.mockResolvedValue({ user: { id: hiveUserId, coderUserId: ownerId } });
  for (const [name, value] of Object.entries({
    HIVE_PUBLIC_ORIGIN: hiveOrigin,
    HIVE_CODEX_ACCOUNTS_ENABLED: "true",
    HIVE_AGENT_TOOLS_ENABLED: "false",
    HIVE_AGENT_TOOLS_TRANSPORT: "workspace-app",
    HIVE_WORKSPACE_ISSUER_MODE: "dedicated",
    HIVE_AGENT_TOOLS_HIVE_ORIGIN: hiveOrigin,
    HIVE_AGENT_TOOLS_ISSUER_KEY_ID: "test",
    HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY: issuer.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    HIVE_AGENT_TOOLS_PINS_JSON: JSON.stringify([
      {
        templateId,
        profile: "software",
        manifestSha256: installedManifest,
        helperSha256: installedHelper,
      },
    ]),
  }))
    vi.stubEnv(name, value);
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("P03 account transport composition without managed persistence", () => {
  it("runs the actual route, User binding, scoped cookie, signed identity and account response", async () => {
    const response = await codexAccountRoute(request(), workspaceId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scope: "managed-native",
      lifetimeId,
      generation: 0,
      state: "signed-out",
      pending: null,
    });
    expect(operations).toEqual(["identity", "codex-account"]);
    expect(mocks.user).toHaveBeenCalledWith({
      where: { id: hiveUserId },
      select: { coderUserId: true },
    });
    expect(mocks.coder).toHaveBeenCalledWith(hiveUserId, { signal: expect.any(AbortSignal) });
    expect(getWorkspace).toHaveBeenCalledTimes(4);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
  it.each([
    "owner",
    "template",
    "selected-build",
    "replacement-build",
    "user-binding",
  ])("denies %s before any workspace-app transport", async (changed) => {
    if (changed === "owner") currentOwner = randomUUID();
    if (changed === "template") currentTemplate = randomUUID();
    if (changed === "replacement-build") currentBuild = randomUUID();
    if (changed === "user-binding") mocks.user.mockResolvedValueOnce({ coderUserId: randomUUID() });
    expect(
      (
        await codexAccountRoute(
          request(changed === "selected-build" ? randomUUID() : buildId),
          workspaceId,
        )
      ).status,
    ).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("denies an installed pin mismatch after identity without issuing the account operation", async () => {
    vi.stubEnv(
      "HIVE_AGENT_TOOLS_PINS_JSON",
      JSON.stringify([
        {
          templateId,
          profile: "software",
          manifestSha256: "c".repeat(64),
          helperSha256: installedHelper,
        },
      ]),
    );
    expect((await codexAccountRoute(request(), workspaceId)).status).toBe(409);
    expect(operations).toEqual(["identity"]);
  });
  it("holds a changed build after the operation without replay or a success response", async () => {
    replaceAfterAction = true;
    expect((await codexAccountRoute(request(), workspaceId)).status).toBe(409);
    expect(operations).toEqual(["identity", "codex-account"]);
  });
});

it.each([
  "duplicate-agent",
  "duplicate-app",
  "shared-app",
  "wrong-port",
  "disconnected-agent",
])("rejects ambiguous or unsafe %s resources before transport", async (changed) => {
  const resources = await getResources.getMockImplementation()!();
  const agent = resources[0].agents[0];
  if (changed === "duplicate-agent") resources[0].agents.push({ ...agent, id: randomUUID() });
  if (changed === "duplicate-app") agent.apps.push({ ...agent.apps[0], id: randomUUID() });
  if (changed === "shared-app") agent.apps[0].sharing_level = "authenticated";
  if (changed === "wrong-port") agent.apps[0].url = "http://127.0.0.1:13343/";
  if (changed === "disconnected-agent") agent.status = "disconnected";
  getResources.mockResolvedValueOnce(resources);
  expect((await codexAccountRoute(request(), workspaceId)).status).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
});
