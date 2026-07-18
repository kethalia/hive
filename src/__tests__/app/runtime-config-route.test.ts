import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/runtime-config.js/route";

describe("GET /runtime-config.js", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns an executable no-store compatibility assignment", async () => {
    vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "/terminal");

    const response = GET();

    expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('window.__HIVE_CONFIG__={"terminalWsUrl":"/terminal"};');
  });
});
