import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  session: vi.fn(),
  discover: vi.fn(),
  framework: vi.fn(),
  close: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@hive/db", () => ({ getDb: () => ({ $queryRaw: mock.query }) }));
vi.mock("@hive/db/cloudflare", () => ({
  createCloudflareDatabaseRequest: () => ({
    run: (work: () => unknown) => work(),
    close: mock.close,
  }),
}));
vi.mock("../../../.open-next/cloudflare/hive-portable-actions.mjs", () => ({
  default: { schemaVersion: 1, actions: {} },
}));
vi.mock("../../../.open-next/worker.js", () => ({ default: { fetch: mock.framework } }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mock.session }));
vi.mock("@/lib/projects/workspace", () => ({
  discoverWorkspaceProjects: mock.discover,
  ProjectDiscoveryError: class extends Error {},
}));

import { GET } from "@/app/api/projects/route";
import worker from "../../../deploy/cloudflare/app/worker";
import authWorker from "../../../deploy/cloudflare/auth/worker";
import { createNativeWorker } from "../../../deploy/cloudflare/native/composition.mjs";

const origin = "https://hive.example",
  bearer = "a".repeat(64);
let tasks: Promise<unknown>[];
const context = {
  waitUntil: (task: Promise<unknown>) => {
    tasks.push(task);
  },
  passThroughOnException() {},
};
const env = () => ({
  PREVIEW_BEARER: bearer,
  HIVE_PREVIEW_ORIGIN: origin,
  HIVE_PROJECT_DISCOVERY_ENABLED: "true",
  HIVE_CODEX_GATEWAY_ENABLED: "true",
});
const request = (
  path = "/api/projects?workspaceId=10000000-0000-4000-8000-000000000001",
  method = "GET",
) => new Request(origin + path, { method, headers: { Authorization: `Bearer ${bearer}` } });
beforeEach(() => {
  vi.clearAllMocks();
  tasks = [];
  vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
  mock.session.mockResolvedValue({ user: { id: "owner", coderUserId: "coder-owner" } });
  mock.discover.mockResolvedValue({ repositories: [] });
  mock.close.mockResolvedValue(undefined);
  mock.query.mockResolvedValue([{ value: 1 }]);
  mock.framework.mockImplementation(async (r: Request) =>
    new URL(r.url).pathname === "/api/projects" ? GET(r) : new Response(null, { status: 404 }),
  );
});
afterEach(async () => {
  await Promise.allSettled(tasks);
  vi.unstubAllEnvs();
});
async function dispatch(r: Request, e = env()) {
  const response = await worker.fetch(r, e, context);
  const value = await response.text();
  return { status: response.status, value };
}
describe("explicit portable terminal and discovery dispatch", () => {
  it("assembled native production health uses the authenticated inline auth handler", async () => {
    const native = createNativeWorker({ app: worker, auth: authWorker, jobs: {} });
    const production = {
      HIVE_NATIVE_MODE: "production",
      HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
      HIVE_RELEASE_HEALTH_ENABLED: "true",
      HIVE_RELEASE_PROBE_SECRET: "b".repeat(64),
      HIVE_RELEASE_SOURCE_SHA: "c".repeat(40),
      HIVE_RELEASE_ARTIFACT_DIGEST: "d".repeat(64),
      AUTH_SERVICE_SECRET: "e".repeat(64),
    };
    const probe = (secret: string) =>
      new Request(`${origin}/.well-known/hive-release-health`, {
        headers: { "X-Hive-Release-Probe": secret },
      });
    const response = await native.fetch(
      probe(production.HIVE_RELEASE_PROBE_SECRET),
      production,
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      app: {
        component: "app",
        ready: true,
        sourceSha: production.HIVE_RELEASE_SOURCE_SHA,
        artifactDigest: production.HIVE_RELEASE_ARTIFACT_DIGEST,
      },
      auth: {
        component: "auth",
        ready: true,
        sourceSha: production.HIVE_RELEASE_SOURCE_SHA,
        artifactDigest: production.HIVE_RELEASE_ARTIFACT_DIGEST,
      },
    });
    expect(mock.query).toHaveBeenCalledTimes(2);
    expect((await native.fetch(probe("wrong"), production, context)).status).toBe(401);
    expect(
      (
        await native.fetch(
          probe(production.HIVE_RELEASE_PROBE_SECRET),
          { ...production, AUTH_SERVICE_SECRET: "" },
          context,
        )
      ).status,
    ).toBe(503);
  });
  it("native production bypasses only the preview credential and keeps route and probe authorization", async () => {
    const production = {
      ...env(),
      HIVE_NATIVE_MODE: "production",
      HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
    };
    mock.session.mockResolvedValue(null);
    const r = new Request(
      `${origin}/api/projects?workspaceId=10000000-0000-4000-8000-000000000001`,
      { headers: { Authorization: "Bearer app-credential" } },
    );
    expect((await dispatch(r, production)).status).toBe(401);
    expect(mock.framework.mock.calls[0][0].headers.get("authorization")).toBe(
      "Bearer app-credential",
    );
    expect(mock.discover).not.toHaveBeenCalled();
    const probe = {
      ...production,
      HIVE_RELEASE_HEALTH_ENABLED: "true",
      HIVE_RELEASE_PROBE_SECRET: "b".repeat(64),
    };
    expect(
      (await dispatch(new Request(`${origin}/.well-known/hive-release-health`), probe)).status,
    ).toBe(401);
  });
  it("inactive or unknown native mode fails before application delegation", async () => {
    for (const e of [
      { ...env(), HIVE_NATIVE_MODE: "production" },
      { ...env(), HIVE_NATIVE_MODE: "bootstrap", HIVE_NATIVE_PRODUCTION_ACTIVE: "true" },
      { ...env(), HIVE_NATIVE_MODE: "other", HIVE_NATIVE_PRODUCTION_ACTIVE: "true" },
      { ...env(), HIVE_NATIVE_MODE: "preview" },
    ])
      expect((await dispatch(request(), e)).status).toBe(503);
    expect(mock.framework).not.toHaveBeenCalled();
  });
  it("fixed discovery GET requires both flags and still executes real route authorization/query validation", async () => {
    expect((await dispatch(request())).status).toBe(200);
    expect(mock.discover).toHaveBeenCalledOnce();
    expect((await dispatch(request("/api/projects?workspaceId=x&unexpected=y"))).status).toBe(400);
    expect(mock.discover).toHaveBeenCalledOnce();
    mock.session.mockResolvedValue(null);
    expect((await dispatch(request())).status).toBe(401);
  });
  it("flag-off or mutation stays rejected before framework/transport", async () => {
    for (const e of [
      { ...env(), HIVE_PROJECT_DISCOVERY_ENABLED: "false" },
      { ...env(), HIVE_CODEX_GATEWAY_ENABLED: "false" },
    ])
      expect((await dispatch(request(), e)).status).toBe(503);
    expect((await dispatch(request("/api/projects", "POST"))).status).toBe(503);
    expect(mock.framework).not.toHaveBeenCalled();
    expect(mock.discover).not.toHaveBeenCalled();
  });
  it("new generic attachment and ticket routes stay default off with no Node fallback", async () => {
    expect((await dispatch(request("/ws"))).status).toBe(404);
    expect((await dispatch(request("/api/auth/terminal-ticket", "POST"))).status).toBe(503);
    expect(mock.framework).not.toHaveBeenCalled();
  });
  it("paste admits only the fixed POST behind its own explicit flag", async () => {
    const path = "/api/workspaces/10000000-0000-4000-8000-000000000001/terminal/paste-assets";
    expect((await dispatch(request(path, "POST"))).status).toBe(503);
    const enabled = { ...env(), HIVE_TERMINAL_PASTE_ENABLED: "true" };
    expect((await dispatch(request(path, "POST"), enabled)).status).toBe(404);
    expect(mock.framework).toHaveBeenCalledOnce();
    expect((await dispatch(request(path, "GET"), enabled)).status).toBe(503);
    expect((await dispatch(request(`${path}/extra`, "POST"), enabled)).status).toBe(503);
    expect(
      (await dispatch(request(path.replace("terminal/paste-assets", "voice"), "POST"), enabled))
        .status,
    ).toBe(503);
    expect(mock.framework).toHaveBeenCalledOnce();
  });
});

it("allows only migrated notification event POST behind its own flag and keeps installer mutations blocked", async () => {
  const post = () => request("/api/notifications/events", "POST");
  expect((await worker.fetch(post(), env(), context)).status).toBe(503);
  mock.framework.mockResolvedValue(new Response(null, { status: 202 }));
  const enabled = { ...env(), HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED: "true" };
  expect((await worker.fetch(post(), enabled, context)).status).toBe(202);
  expect(
    (await worker.fetch(request("/api/notifications/events", "GET"), enabled, context)).status,
  ).toBe(503);
  for (const method of ["POST", "DELETE"])
    expect(
      (await worker.fetch(request("/api/notifications/sources", method), enabled, context)).status,
    ).toBe(503);
});
