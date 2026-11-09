import { expect, it } from "vitest";
import { isDatabaseJobTransport } from "@/lib/delivery/database-job-transport";

it("admits only enabled exact OIDC machine transports without browser origin or query", () => {
  const request = (path: string, headers: Record<string, string> = {}, method = "POST") =>
    new Request(`https://hive.invalid${path}`, {
      method,
      headers: { "x-hive-database-oidc": "a.b.c", ...headers },
    });
  for (const path of [
    "/api/delivery/database-jobs/approve",
    "/api/delivery/database-jobs/authorize",
  ]) {
    expect(isDatabaseJobTransport(request(path), "true")).toBe(true);
    expect(isDatabaseJobTransport(request(path))).toBe(false);
    expect(isDatabaseJobTransport(request(`${path}?x=1`), "true")).toBe(false);
    expect(isDatabaseJobTransport(request(path, { origin: "https://hive.invalid" }), "true")).toBe(
      false,
    );
    expect(isDatabaseJobTransport(request(path, {}, "GET"), "true")).toBe(false);
    expect(isDatabaseJobTransport(request(path, { "content-length": "49153" }), "true")).toBe(
      false,
    );
  }
  expect(isDatabaseJobTransport(request("/api/delivery/database-jobs/other"), "true")).toBe(false);
});
