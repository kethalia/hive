import { randomUUID } from "node:crypto";
import { getDb } from "@hive/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { WorkspaceReadClient } from "@/lib/workspaces/read-client.server";
import type { WorkspaceReadProfile } from "@/lib/workspaces/read-contracts";
import {
  createWorkspaceReadService,
  WorkspaceReadService,
  workspaceReadServiceConfig,
} from "@/lib/workspaces/read-service.server";
import { readFixture } from "./read-fixture";

vi.mock("@hive/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: vi.fn() }));
const fixtures: ReturnType<typeof readFixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture(profile: WorkspaceReadProfile = "software") {
  const f = readFixture(profile);
  fixtures.push(f);
  const dispatch = vi.fn(async (ticket: string) => f.host.dispatch({ ticket })),
    coderForPrincipal = vi.fn(async () => f.coder),
    service = new WorkspaceReadService(
      {
        ...f.config,
        profiles: [
          { templateId: f.binding.templateId, profile, manifestSha256: f.config.manifestSha256 },
        ],
        cookieDomains: [],
      },
      {
        coderForPrincipal,
        client: (c, coder, binding) =>
          new WorkspaceReadClient(c, coder, binding, async (_c, _b, r) => dispatch(r.ticket)),
      },
    );
  return { ...f, service, dispatch, coderForPrincipal };
}
describe("owner/current-build/app-authorized workspace reads", () => {
  it("works on each explicitly pinned profile without project or native registration", async () => {
    for (const profile of [
      "software",
      "browser",
      "game",
      "electronics",
      "infrastructure",
    ] as const) {
      const f = fixture(profile);
      const bound = await f.service.readBound(f.principal, f.binding.workspaceId, {
        operation: "sessions",
      });
      expect(bound.data).toEqual({ sessions: [], nextCursor: null });
      expect(bound.binding).toMatchObject({
        workspaceId: f.binding.workspaceId,
        buildId: f.binding.buildId,
        ownerId: f.binding.ownerId,
        agentId: f.binding.agentId,
      });
      expect(f.coderForPrincipal).toHaveBeenCalledTimes(1);
      expect(f.coder.getWorkspace).toHaveBeenCalledTimes(4);
      expect(f.coder.getWorkspaceResources).toHaveBeenCalledTimes(2);
      expect(f.dispatch).toHaveBeenCalledTimes(2);
    }
  });
  it("rejects foreign owners, unknown templates, disconnected/ambiguous agents and nonprivate apps before signing", async () => {
    for (const failure of ["owner", "template", "disconnected", "ambiguous", "shared", "port"]) {
      const f = fixture();
      if (failure === "owner") f.workspace.owner_id = randomUUID();
      else if (failure === "template") f.workspace.template_id = randomUUID();
      else if (failure === "disconnected") f.resources[0].agents![0].status = "disconnected";
      else if (failure === "ambiguous")
        f.resources[0].agents!.push({
          ...f.resources[0].agents![0],
          id: randomUUID(),
          name: "other",
        });
      else if (failure === "shared") f.app.sharing_level = "authenticated";
      else f.app.url = "http://127.0.0.1:4444";
      await expect(
        f.service.read(f.principal, f.binding.workspaceId, { operation: "sessions" }),
      ).rejects.toMatchObject({ code: "workspace_unavailable" });
      expect(f.dispatch).not.toHaveBeenCalled();
    }
  });
  it("does not return an old positive read when owner/build/app changes during the request", async () => {
    for (const failure of ["owner", "build", "app"]) {
      const f = fixture(),
        original = f.host.dispatch.bind(f.host);
      f.host.dispatch = async (value) => {
        const result = await original(value);
        if (result.operation === "sessions") {
          if (failure === "owner") f.workspace.owner_id = randomUUID();
          else if (failure === "build") f.workspace.latest_build.id = randomUUID();
          else f.app.sharing_level = "public";
        }
        return result;
      };
      await expect(
        f.service.read(f.principal, f.binding.workspaceId, { operation: "sessions" }),
      ).rejects.toMatchObject({ code: "workspace_unavailable" });
      expect(f.dispatch).toHaveBeenCalledTimes(2);
    }
  });
  it("preserves browser/infrastructure File Browser restrictions and cancellation", async () => {
    for (const profile of ["browser", "infrastructure"] as const) {
      const f = fixture(profile);
      await expect(
        f.service.read(f.principal, f.binding.workspaceId, {
          operation: "paths",
          sessionName: "main",
          paths: ["a.txt"],
        }),
      ).rejects.toMatchObject({ code: "unsupported_profile_operation" });
      expect(f.dispatch).not.toHaveBeenCalled();
    }
    const f = fixture(),
      abort = new AbortController();
    abort.abort();
    await expect(
      f.service.read(f.principal, f.binding.workspaceId, { operation: "sessions" }, abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.coderForPrincipal).not.toHaveBeenCalled();
  });
  it("production factory rechecks the persisted Hive-to-Coder owner before obtaining credentials", async () => {
    const f = fixture(),
      findUnique = vi.fn(async () => ({ coderUserId: randomUUID() }));
    vi.mocked(getDb).mockReturnValue({ user: { findUnique } } as unknown as ReturnType<
      typeof getDb
    >);
    const service = createWorkspaceReadService({
      ...f.config,
      profiles: [
        {
          templateId: f.binding.templateId,
          profile: "software",
          manifestSha256: f.config.manifestSha256,
        },
      ],
      cookieDomains: [],
    });
    await expect(
      service.read(f.principal, f.binding.workspaceId, { operation: "sessions" }),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: f.principal.hiveUserId },
      select: { coderUserId: true },
    });
    expect(getCoderClientForUser).not.toHaveBeenCalled();
  });
  it("configuration defaults off and requires an explicit unique profile map and issuer", () => {
    const f = fixture(),
      env = {
        HIVE_WORKSPACE_READ_ENABLED: "true",
        HIVE_WORKSPACE_READ_PROFILES_JSON: JSON.stringify([
          {
            templateId: f.binding.templateId,
            profile: "software",
            manifestSha256: f.config.manifestSha256,
          },
        ]),
        HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY: f.config.privateKeyPem,
        HIVE_WORKSPACE_READ_ISSUER_KEY_ID: f.config.keyId,
        HIVE_WORKSPACE_READ_HIVE_ORIGIN: f.config.hiveOrigin,
      };
    expect(() => workspaceReadServiceConfig({})).toThrow("disabled");
    expect(workspaceReadServiceConfig(env).profiles[0].profile).toBe("software");
    expect(() =>
      workspaceReadServiceConfig({
        ...env,
        HIVE_WORKSPACE_READ_PROFILES_JSON: JSON.stringify([
          JSON.parse(env.HIVE_WORKSPACE_READ_PROFILES_JSON)[0],
          JSON.parse(env.HIVE_WORKSPACE_READ_PROFILES_JSON)[0],
        ]),
      }),
    ).toThrow("disabled");
    expect(() =>
      workspaceReadServiceConfig({ ...env, HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY: "" }),
    ).toThrow("disabled");
  });
});
