import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ allocate: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock("@hive/db/cloudflare", () => ({
  createCloudflareDatabaseRequest: () => {
    state.allocate();
    return { run: <T>(fn: () => T) => fn(), close: state.close };
  },
}));

import { createAppWorker } from "../../../../deploy/cloudflare/app/composition";

it("threads the read gate through the actual Worker composition without enabling repository SSH", async () => {
  const framework = vi.fn(async () => Response.json({ data: [] })),
    worker = createAppWorker({ fetch: framework }, { schemaVersion: 1, actions: {} }),
    env = {
      HIVE_NATIVE_MODE: "preview",
      HIVE_NATIVE_PREVIEW_ENABLED: "true",
      HIVE_PREVIEW_ACCESS_REQUIRED: "false",
      HIVE_PREVIEW_ORIGIN: "https://fixture.invalid",
    };
  const read = async (path: string, enabled: string, method = "GET") => {
    const tasks: Promise<unknown>[] = [],
      r = await worker.fetch(
        new Request(`https://fixture.invalid/api/discovery/${path}?workspaceId=fixture`, {
          method,
        }),
        { ...env, HIVE_WORKSPACE_READ_ENABLED: enabled },
        { waitUntil: (p) => tasks.push(p), passThroughOnException() {} },
      );
    await r.text();
    await Promise.all(tasks);
    return r;
  };
  expect((await read("sessions", "false")).status).toBe(503);
  expect(framework).not.toHaveBeenCalled();
  expect((await read("sessions", "true")).status).toBe(200);
  expect(framework).toHaveBeenCalledTimes(1);
  expect(state.allocate).toHaveBeenCalledTimes(1);
  expect((await read("repositories", "true")).status).toBe(503);
  expect((await read("sessions", "true", "POST")).status).toBe(503);
  expect(framework).toHaveBeenCalledTimes(1);
});
