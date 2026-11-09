import { describe, expect, it, vi } from "vitest";
import fixture from "../../../../deploy/cloudflare/auth/f08-restored-fixture.worker";

describe("F08 local fixture route boundary", () => {
  it("forwards only the RLS-scoped task list and logout", async () => {
    const id = "11111111-1111-4111-8111-111111111111",
      fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const env = { F08_RUN_ID: id, APP: { fetch: fetcher } } as never,
      context = {} as never;
    for (const [method, path] of [
      ["GET", "/api/delivery/tasks/22222222-2222-4222-8222-222222222222"],
      ["POST", `/api/delivery/tasks/${id}`],
      ["GET", "/api/auth/logout"],
      ["POST", "/api/auth/login"],
      ["GET", "/api/delivery/tasks?x=1"],
    ]) {
      const response = await fixture.fetch(
        new Request(`http://localhost${path}`, { method }),
        env,
        context,
      );
      expect(response.status).toBe(404);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await fixture.fetch(new Request("http://localhost/api/delivery/tasks"), env, context))
        .status,
    ).toBe(204);
    expect(
      (
        await fixture.fetch(
          new Request("http://localhost/api/auth/logout", { method: "POST" }),
          env,
          context,
        )
      ).status,
    ).toBe(204);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
